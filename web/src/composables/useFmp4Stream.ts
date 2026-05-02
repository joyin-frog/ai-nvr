import { ref, onUnmounted, type Ref } from 'vue'
import { authWsUrl } from '../services/auth'

/**
 * fMP4/MSE 流播放器
 * 通过 WebSocket 接收 fMP4 段，用 MediaSource + <video> 硬件解码
 * 零 CPU 解码开销，GPU 原生渲染
 *
 * WS 二进制协议：
 * Init segment: [0x01][2B codec长度 LE uint16][codec ASCII][fMP4 data]
 * Media segment: [0x02][fMP4 data]
 */
const FMP4_TYPE_INIT = 0x01
const FMP4_TYPE_MEDIA = 0x02

/** 全局 TextDecoder 单例（避免每次 init segment 创建新实例） */
const textDecoder = new TextDecoder()

/** 全局共享 prune 循环：避免每个 fMP4 实例独立 setInterval */
const activeStreams = new Set<{ pruneBuffer: () => void; catchUpToLive: () => void }>()
let sharedPruneTimer: ReturnType<typeof setInterval> | null = null
let sharedPruneRefCount = 0

function registerStream(stream: { pruneBuffer: () => void; catchUpToLive: () => void }) {
  activeStreams.add(stream)
  sharedPruneRefCount++
  if (!sharedPruneTimer) {
    sharedPruneTimer = setInterval(() => {
      for (const s of activeStreams) {
        s.pruneBuffer()
      }
    }, 300)
  }
}

function unregisterStream(stream: { pruneBuffer: () => void; catchUpToLive: () => void }) {
  activeStreams.delete(stream)
  sharedPruneRefCount--
  if (sharedPruneRefCount <= 0 && sharedPruneTimer) {
    clearInterval(sharedPruneTimer)
    sharedPruneTimer = null
    sharedPruneRefCount = 0
  }
}

/** 保留当前播放位置前多少秒缓冲区（0.2s 约 2.5 个 GOP，减少 prune 频率同时保持低延迟） */
const BUFFER_RETAIN_SECONDS = 0.2

/** 播放延迟超过此值（秒）时开始渐进追赶 */
const LIVE_CATCHUP_THRESHOLD = 0.04

/** 延迟超过此值（秒）直接 seek 到最新（给渐进追赶留更多空间，减少跳帧） */
const LIVE_SEEK_THRESHOLD = 0.5

/** pending 队列最大段数，超过则丢弃最旧的段 */
const MAX_PENDING_SEGMENTS = 8

export function useFmp4Stream(cameraId: Ref<string>) {
  /** video 元素引用 */
  const videoRef = ref<HTMLVideoElement | null>(null)
  /** 是否已连接 */
  const connected = ref(false)
  /** 是否正在播放 */
  const playing = ref(false)
  /** 当前解码分辨率 */
  const videoWidth = ref(0)
  const videoHeight = ref(0)
  /** MSE 连接是否彻底失败（连续重连失败），用于回退到 Canvas */
  const failed = ref(false)
  /** MSE 模式 FPS（从 media segment 到达频率计算） */
  const fps = ref(0)

  let mediaSource: MediaSource | null = null
  let sourceBuffer: SourceBuffer | null = null
  let ws: WebSocket | null = null
  /** 待 append 的段队列 */
  let pendingQueue: ArrayBuffer[] = []
  /** 是否正在 append */
  let appending = false
  /** 重连定时器 */
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  /** 重连次数 */
  let retryCount = 0
  /** 当前使用的 codec */
  let currentCodec = ''
  /** FPS 统计（使用 requestVideoFrameCallback 精确测量实际视频帧率） */
  let fpsFrameCount = 0
  let fpsStartTime = 0
  let videoFrameCallbackId: number | null = null
  /** video 元素事件处理器引用（用于清理） */
  let videoEventHandlers: Array<{ event: string; handler: EventListener }> = []
  /** 待重初始化的 init segment（ffmpeg 重启后等待第一个 media segment 一起处理） */
  let pendingInit: ArrayBuffer | null = null

  /** 解码检测定时器：连接后一段时间内 videoWidth=0 则判定为解码失败 */
  let decodeCheckTimer: ReturnType<typeof setTimeout> | null = null
  /** pruneBuffer 是否正在执行中（防止 remove 和 append 竞争） */
  let pruning = false

  /** 设置 video 元素 */
  function setVideo(el: HTMLVideoElement | null) {
    /** 清理旧的 video frame callback */
    if (videoFrameCallbackId != null && videoRef.value) {
      videoRef.value.cancelVideoFrameCallback?.(videoFrameCallbackId)
      videoFrameCallbackId = null
    }
    /** 清理旧事件 */
    if (videoRef.value) {
      for (const { event, handler } of videoEventHandlers) {
        videoRef.value.removeEventListener(event, handler)
      }
      videoEventHandlers = []
    }

    videoRef.value = el

    /** 绑定 video 元素事件 */
    if (el) {
      bindVideoEvents(el)
      /** 如果已有 MediaSource 但还没绑定到 video，现在绑定 */
      if (mediaSource && !el.src) {
        if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl)
        currentBlobUrl = URL.createObjectURL(mediaSource)
        el.src = currentBlobUrl
      }
      /** 使用 requestVideoFrameCallback 精确测量实际视频帧率 */
      if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
        fpsStartTime = performance.now()
        fpsFrameCount = 0
        const measureFps = (_now: number, _metadata: unknown) => {
          fpsFrameCount++
          const elapsed = performance.now() - fpsStartTime
          if (elapsed >= 2000) {
            fps.value = Math.round(fpsFrameCount * 1000 / elapsed)
            fpsFrameCount = 0
            fpsStartTime = performance.now()
          }
          videoFrameCallbackId = el.requestVideoFrameCallback(measureFps)
        }
        videoFrameCallbackId = el.requestVideoFrameCallback(measureFps)
      }
    }
  }

  /** 绑定 video 元素的关键事件 */
  function bindVideoEvents(el: HTMLVideoElement) {
    /** 播放卡住时立即 seek 到最新位置（不等待 rAF，减少 16ms 延迟） */
    const onWaiting = () => {
      if (!videoRef.value || !sourceBuffer) return
      catchUpToLive()
    }

    /** 解码错误时重连（通过 scheduleReconnect 带退避和上限） */
    const onError = () => {
      const err = el.error
      if (err) {
        console.warn(`[fMP4] video error: code=${err.code} ${err.message}`)
        /** MEDIA_ERR_DECODE (3) 或 MEDIA_ERR_SRC_NOT_SUPPORTED (4) → 延迟重连 */
        if (err.code >= 3) {
          ws?.close()
          scheduleReconnect()
        }
      }
    }

    const onPlaying = () => {
      playing.value = true
    }

    const onPause = () => {
      playing.value = false
    }

    el.addEventListener('waiting', onWaiting)
    el.addEventListener('error', onError)
    el.addEventListener('playing', onPlaying)
    el.addEventListener('pause', onPause)

    videoEventHandlers = [
      { event: 'waiting', handler: onWaiting },
      { event: 'error', handler: onError },
      { event: 'playing', handler: onPlaying },
      { event: 'pause', handler: onPause },
    ]
  }

  /** 追赶直播：渐进式加速，延迟过大直接 seek */
  function catchUpToLive() {
    const video = videoRef.value
    if (!video || !sourceBuffer || sourceBuffer.updating) return
    const buffered = sourceBuffer.buffered
    if (buffered.length === 0) return

    const end = buffered.end(buffered.length - 1)
    const delay = end - video.currentTime

    if (delay > LIVE_SEEK_THRESHOLD) {
      /** 延迟过大直接 seek 到最新 */
      video.currentTime = end - 0.05
    } else if (delay > LIVE_CATCHUP_THRESHOLD) {
      /** 渐进追赶：延迟越大速度越快，最大 4x */
      const rate = Math.min(4.0, 1.0 + (delay - LIVE_CATCHUP_THRESHOLD) * 5)
      if (video.playbackRate !== rate) {
        video.playbackRate = rate
      }
    } else if (video.playbackRate !== 1) {
      /** 追上后恢复正常速度 */
      video.playbackRate = 1
    }
  }

  /** 当前 blob URL（用于清理释放） */
  let currentBlobUrl: string | null = null

  /** 连接 fMP4 流 */
  const streamHandle = { pruneBuffer, catchUpToLive }
  function connect() {
    disconnect()
    pendingQueue = []
    pendingInit = null
    appending = false
    pruning = false
    currentCodec = ''
    fpsFrameCount = 0
    fpsStartTime = performance.now()

    mediaSource = new MediaSource()
    if (videoRef.value) {
      /** 释放旧 blob URL */
      if (currentBlobUrl) {
        URL.revokeObjectURL(currentBlobUrl)
      }
      currentBlobUrl = URL.createObjectURL(mediaSource)
      videoRef.value.src = currentBlobUrl
    }

    mediaSource.addEventListener('sourceopen', onSourceOpen)
    mediaSource.addEventListener('sourceclose', () => {
      connected.value = false
    })
  }

  function onSourceOpen() {
    const url = authWsUrl(`/api/stream/${cameraId.value}`)
    connectWs(url)
  }

  function connectWs(url: string) {
    ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'

    ws.onopen = () => {
      connected.value = true
      retryCount = 0
      /** 启动解码检测：5 秒后如果 video 仍无解码输出，判定为不支持 */
      if (decodeCheckTimer) clearTimeout(decodeCheckTimer)
      decodeCheckTimer = setTimeout(() => {
        if (!videoRef.value) return
        /** videoWidth > 0 说明解码成功 */
        if (videoRef.value.videoWidth > 0) return
        /** 有数据但无法解码 — 可能是浏览器不支持该 codec */
        console.warn('[fMP4] 5秒内未检测到解码输出，codec 可能不被支持，回退到 Canvas')
        failed.value = true
      }, 5000)
    }

    ws.onmessage = (event) => {
      const raw = new Uint8Array(event.data as ArrayBuffer)
      if (raw.length === 0) return

      const type = raw[0]

      if (type === FMP4_TYPE_INIT) {
        /** 解析 codec + fMP4 data */
        if (raw.length < 3) return
        const codecLen = (raw[2]! << 8) | raw[1]!
        if (raw.length < 3 + codecLen) return
        const codec = textDecoder.decode(raw.subarray(3, 3 + codecLen))
        /** slice 创建独立 ArrayBuffer，避免 subarray.buffer 指向完整原始 buffer */
        const fmp4Data = raw.slice(3 + codecLen).buffer

        /** codec 变化时需要重建 SourceBuffer */
        if (currentCodec !== codec) {
          currentCodec = codec
          if (!ensureSourceBuffer(codec)) {
            failed.value = true
            ws?.close()
            return
          }
          /** 新 SourceBuffer：直接 append init segment */
          pendingInit = null
          doAppend(fmp4Data)
        } else {
          /**
           * 同 codec：ffmpeg 重启/分辨率变化后重发 init segment
           * 缓存 init segment，等下一个 media segment 到来时再一起重建缓冲区
           * 这样避免在收到 init 和 media 之间出现黑屏
           */
          pendingInit = fmp4Data
          pendingQueue = []
        }
      } else if (type === FMP4_TYPE_MEDIA) {
        /** slice 创建独立 ArrayBuffer，避免将 type 标记字节传入 MSE */
        const fmp4Data = raw.slice(1).buffer

        /** 有待处理的 init segment：先 append 新数据，再异步清理旧缓冲区 */
        if (pendingInit) {
          const initData = pendingInit
          pendingInit = null
          /** 直接 append init + media，不先 remove — 新数据到来后视频立刻有内容，消除黑闪 */
          doAppend(initData)
          queueAppend(fmp4Data)
          /** 延迟清理旧缓冲区（等新数据 append 完成后由 pruneBuffer 异步处理） */
        } else {
          queueAppend(fmp4Data)
        }
      }
    }

    ws.onclose = () => {
      connected.value = false
      scheduleReconnect()
    }

    ws.onerror = () => {
      ws?.close()
    }
  }

  /** 创建或重建 SourceBuffer，返回是否成功 */
  function ensureSourceBuffer(codec: string): boolean {
    if (!mediaSource || mediaSource.readyState !== 'open') return false

    /** 移除旧的 SourceBuffer */
    if (sourceBuffer) {
      sourceBuffer.removeEventListener('updateend', onUpdateEnd)
      if (!sourceBuffer.updating) {
        mediaSource.removeSourceBuffer(sourceBuffer)
      }
      sourceBuffer = null
    }

    /** 优先使用服务器提供的 codec，失败则回退 */
    const hevcCodecs = ['hvc1.1.6.L93.B0', 'hev1.1.6.L93.B0']
    const avcCodecs = ['avc1.640029', 'avc1.64001F', 'avc1.4D401F', 'avc1.42C01E']
    /** HEVC codec 优先使用服务端提供的，否则用通用 HEVC */
    const codecs = codec.startsWith('hvc1') || codec.startsWith('hev1')
      ? [codec, ...hevcCodecs, ...avcCodecs]
      : [codec, ...avcCodecs, ...hevcCodecs]
    /** 去重 */
    const unique = [...new Set(codecs)]

    /** 先用 isTypeSupported 过滤掉明确不支持的 codec，避免抛异常 */
    const supported = unique.filter(c =>
      MediaSource.isTypeSupported(`video/mp4; codecs="${c}"`)
    )
    if (supported.length === 0) {
      console.warn(`[fMP4] 浏览器不支持任何候选 codec (${unique.join(', ')})，回退到 Canvas`)
      return false
    }

    for (const c of supported) {
      try {
        sourceBuffer = mediaSource.addSourceBuffer(`video/mp4; codecs="${c}"`)
        sourceBuffer.addEventListener('updateend', onUpdateEnd)
        sourceBuffer.addEventListener('error', onBufferError)
        sourceBuffer.mode = 'segments'
        console.debug(`[fMP4] SourceBuffer created: ${c}`)
        return true
      } catch {
        /** codec 不支持，尝试下一个 */
      }
    }
    console.error('[fMP4] 无法创建 SourceBuffer')
    return false
  }

  function queueAppend(data: ArrayBuffer) {
    if (appending || pruning) {
      pendingQueue.push(data)
      /** 队列溢出保护：只保留最新段，丢弃旧的（实时流优先展示最新画面） */
      if (pendingQueue.length > MAX_PENDING_SEGMENTS) {
        const newest = pendingQueue[pendingQueue.length - 1]!
        pendingQueue = [newest]
      }
      return
    }
    doAppend(data)
  }

  function doAppend(data: ArrayBuffer) {
    if (!sourceBuffer || sourceBuffer.updating || pruning) {
      pendingQueue.push(data)
      if (pendingQueue.length > MAX_PENDING_SEGMENTS) {
        const newest = pendingQueue[pendingQueue.length - 1]!
        pendingQueue = [newest]
      }
      return
    }
    appending = true
    try {
      sourceBuffer.appendBuffer(data)
    } catch (e) {
      appending = false
      /** QuotaExceeded: 清理全部缓冲区后重试当前段 */
      if (sourceBuffer && e instanceof DOMException && e.name === 'QuotaExceededError') {
        console.warn('[fMP4] QuotaExceeded，清理缓冲区并重试')
        /** 清理全部已缓冲数据 */
        if (!sourceBuffer.updating && sourceBuffer.buffered.length > 0) {
          pruning = true
          try {
            sourceBuffer.remove(sourceBuffer.buffered.start(0), sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1))
          } catch { /* ignore */ }
        }
        /** 丢弃待处理队列，等待清理完成后重试当前段 */
        pendingQueue = [data]
      }
    }
  }

  /** SourceBuffer error 事件处理 */
  function onBufferError(): void {
    console.warn('[fMP4] SourceBuffer error，尝试清理缓冲区')
    if (!sourceBuffer) return
    appending = false
    pruning = false
    pendingQueue = []
    /** 清理已缓冲的数据 */
    if (!sourceBuffer.updating && mediaSource?.readyState === 'open') {
      const buffered = sourceBuffer.buffered
      if (buffered.length > 0) {
        try {
          sourceBuffer.remove(buffered.start(0), buffered.end(buffered.length - 1))
        } catch { /* ignore */ }
      }
    }
  }

  function onUpdateEnd() {
    /** 区分 append 完成还是 remove 完成 */
    const wasAppending = appending
    const wasPruning = pruning
    appending = false
    pruning = false

    /** remove 完成：如果有等待的数据，立即处理 */
    if (wasPruning && pendingQueue.length > 0) {
      drainPending()
      return
    }

    /** append 完成：处理队列中的段 */
    if (wasAppending && pendingQueue.length > 0) {
      drainPending()
    }

    /** append 完成后立即追赶直播 + 修剪旧缓冲（消除定时器延迟） */
    if (wasAppending) {
      catchUpToLive()
      pruneBuffer()
    }

    /** 确保 video 播放位置在有效缓冲区内 */
    if (wasAppending && videoRef.value && sourceBuffer && sourceBuffer.buffered.length > 0) {
      const video = videoRef.value
      const bufEnd = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1)
      /** currentTime 落在缓冲区外 → seek 到最新数据末尾附近 */
      if (video.currentTime < bufEnd - 2 || video.currentTime > bufEnd) {
        video.currentTime = bufEnd - 0.05
      }
    }

    /** 自动播放 */
    if (videoRef.value && videoRef.value.paused && sourceBuffer?.buffered.length) {
      videoRef.value.play().then(() => {
        playing.value = true
      }).catch(() => { /* autoplay blocked */ })
    }

    /** 分辨率变化时才更新（避免每帧触发 reactive set） */
    if (videoRef.value) {
      const w = videoRef.value.videoWidth
      const h = videoRef.value.videoHeight
      if (w && h && (videoWidth.value !== w || videoHeight.value !== h)) {
        videoWidth.value = w
        videoHeight.value = h
      }
    }
  }

  /** 从 pendingQueue 取出段追加（优先低延迟：单段立即追加） */
  function drainPending() {
    if (pendingQueue.length === 0 || !sourceBuffer || sourceBuffer.updating) return
    if (pendingQueue.length === 1) {
      /** 单段直接追加，零额外延迟 */
      doAppend(pendingQueue.shift()!)
      return
    }
    /** 多段合并为一次 append（减少 MSE API 调用开销） */
    const batch = pendingQueue.splice(0, pendingQueue.length)
    const total = batch.reduce((sum, b) => sum + b.byteLength, 0)
    const merged = new Uint8Array(total)
    let offset = 0
    for (const buf of batch) {
      merged.set(new Uint8Array(buf), offset)
      offset += buf.byteLength
    }
    doAppend(merged.buffer)
  }

  /** 清除已播放的缓冲区，防止内存增长（只在定时器中调用，避免与 append 竞争） */
  function pruneBuffer() {
    if (!sourceBuffer || !videoRef.value || sourceBuffer.updating || appending || pruning) return
    const buffered = sourceBuffer.buffered
    if (buffered.length === 0) return

    const currentTime = videoRef.value.currentTime

    /** 如果有多个 buffered range（init segment 切换后旧 range 残留），清理掉当前 range 之前的所有旧 range */
    if (buffered.length > 1) {
      /** 找到 currentTime 所在的 range */
      let activeIdx = -1
      for (let i = 0; i < buffered.length; i++) {
        if (currentTime >= buffered.start(i) && currentTime <= buffered.end(i)) {
          activeIdx = i
          break
        }
      }
      /** 如果 currentTime 不在任何 range 中，清理到最新 range 的起点 */
      if (activeIdx <= 0) {
        const latestStart = buffered.start(buffered.length - 1)
        if (currentTime < latestStart) {
          pruning = true
          try {
            sourceBuffer.remove(buffered.start(0), latestStart)
          } catch {
            pruning = false
          }
          return
        }
      }
      /** 清理 activeIdx 之前的所有旧 range */
      if (activeIdx > 0) {
        pruning = true
        try {
          sourceBuffer.remove(buffered.start(0), buffered.start(activeIdx))
        } catch {
          pruning = false
        }
        return
      }
    }

    /** 单 range：正常清理已播放部分 */
    const start = buffered.start(0)
    const behindDuration = currentTime - start
    if (behindDuration > BUFFER_RETAIN_SECONDS + 1) {
      pruning = true
      try {
        sourceBuffer.remove(start, currentTime - BUFFER_RETAIN_SECONDS)
      } catch {
        pruning = false
      }
    }
  }

  /** 重连 */
  function scheduleReconnect() {
    if (reconnectTimer) return
    retryCount++
    /** 连续失败 5 次标记为失败，让 CameraView 回退到 Canvas 模式 */
    if (retryCount >= 5) {
      console.warn('[fMP4] 连续 5 次连接失败，标记为失败')
      failed.value = true
      return
    }
    /** 首次 200ms 快速重连，后续指数退避 */
    const delay = Math.min(200 * Math.pow(2, retryCount - 1), 30000)
    console.warn(`[fMP4] ${delay / 1000}s 后重连 (第 ${retryCount} 次)`)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, delay)
  }

  /** 断开连接 */
  function disconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    /** 清理 video frame callback */
    if (videoFrameCallbackId != null && videoRef.value) {
      try { videoRef.value.cancelVideoFrameCallback?.(videoFrameCallbackId) } catch { /* */ }
      videoFrameCallbackId = null
    }
    if (decodeCheckTimer) {
      clearTimeout(decodeCheckTimer)
      decodeCheckTimer = null
    }
    unregisterStream(streamHandle)
    ws?.close()
    ws = null
    if (sourceBuffer && mediaSource && mediaSource.readyState === 'open') {
      try {
        mediaSource.removeSourceBuffer(sourceBuffer)
      } catch { /* */ }
    }
    sourceBuffer = null
    if (mediaSource) {
      mediaSource.removeEventListener('sourceopen', onSourceOpen)
      if (mediaSource.readyState === 'open') {
        mediaSource.endOfStream()
      }
    }
    mediaSource = null
    /** 释放 blob URL */
    if (currentBlobUrl) {
      URL.revokeObjectURL(currentBlobUrl)
      currentBlobUrl = null
    }
    currentCodec = ''
    pendingInit = null
    pendingQueue = []
    appending = false
    pruning = false
    connected.value = false
    playing.value = false
    fps.value = 0
    failed.value = false
  }

  /** 注册到全局共享 prune 循环（避免每个实例独立 setInterval） */
  registerStream(streamHandle)

  /** 页面隐藏时暂停 fMP4 流（节省带宽），可见时恢复 */
  let wasConnectedBeforeHidden = false
  const onVisibilityChange = () => {
    if (document.hidden) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        wasConnectedBeforeHidden = true
        disconnect()
        console.debug('[fMP4] 页面隐藏，暂停流')
      }
    } else if (wasConnectedBeforeHidden) {
      wasConnectedBeforeHidden = false
      connect()
      console.debug('[fMP4] 页面可见，恢复流')
    }
  }
  document.addEventListener('visibilitychange', onVisibilityChange)

  /** 元素视口可见性 — 不可见时断开流节省带宽 */
  let isInViewport = true
  let wasConnectedBeforeHiddenViewport = false

  /** 外部调用：设置当前视口可见状态 */
  function setVisible(visible: boolean) {
    if (visible === isInViewport) return
    isInViewport = visible
    if (!visible) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        wasConnectedBeforeHiddenViewport = true
        disconnect()
        console.debug(`[fMP4] ${cameraId.value} 离开视口，暂停流`)
      }
    } else if (wasConnectedBeforeHiddenViewport) {
      wasConnectedBeforeHiddenViewport = false
      connect()
      console.debug(`[fMP4] ${cameraId.value} 进入视口，恢复流`)
    }
  }

  onUnmounted(() => {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    disconnect()
  })

  return {
    videoRef,
    setVideo,
    connect,
    disconnect,
    connected,
    playing,
    videoWidth,
    videoHeight,
    fps,
    failed,
    setVisible,
  }
}
