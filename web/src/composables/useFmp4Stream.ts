import { ref, onUnmounted, type Ref } from 'vue'
import { authWsUrl } from '../services/auth'

/**
 * fMP4/MSE 流播放器
 * 通过 WebSocket 接收 fMP4 段，用 MediaSource + <video> 硬件解码
 *
 * WS 二进制协议：
 * Init segment: [0x01][2B codec长度 LE uint16][codec ASCII][2B audio_codec_len LE][audio_codec][fMP4 data]
 * Media segment: [0x02][fMP4 data]
 */
const FMP4_TYPE_INIT = 0x01
const FMP4_TYPE_MEDIA = 0x02

/** 全局 TextDecoder 单例 */
const textDecoder = new TextDecoder()

/** 全局共享 rAF 循环 */
const activeStreams = new Set<{ pruneBuffer: () => void; needsPrune: boolean }>()
let sharedRafId: number | null = null
let sharedPruneRefCount = 0

function rafLoop() {
  for (const s of activeStreams) {
    if (s.needsPrune) {
      s.needsPrune = false
      s.pruneBuffer()
    }
  }
  if (activeStreams.size > 0) {
    sharedRafId = requestAnimationFrame(rafLoop)
  }
}

function registerStream(stream: { pruneBuffer: () => void; needsPrune: boolean }) {
  activeStreams.add(stream)
  sharedPruneRefCount++
  if (sharedRafId === null) {
    sharedRafId = requestAnimationFrame(rafLoop)
  }
}

function unregisterStream(stream: { pruneBuffer: () => void; needsPrune: boolean }) {
  activeStreams.delete(stream)
  sharedPruneRefCount--
  if (sharedPruneRefCount <= 0) {
    if (sharedRafId !== null) {
      cancelAnimationFrame(sharedRafId)
      sharedRafId = null
    }
    sharedPruneRefCount = 0
  }
}

/** 保留当前播放位置前多少秒缓冲区 */
const BUFFER_RETAIN_SECONDS = 0.3

/** 延迟超过此值（秒）seek 到最新 */
const LIVE_SEEK_THRESHOLD = 0.3

/** pending 队列最大段数 */
const MAX_PENDING_SEGMENTS = 5

export function useFmp4Stream(cameraId: Ref<string>) {
  const videoRef = ref<HTMLVideoElement | null>(null)
  const connected = ref(false)
  const playing = ref(false)
  const videoWidth = ref(0)
  const videoHeight = ref(0)
  /** MSE 连接是否彻底失败 */
  const failed = ref(false)
  /** 用户真实看到的渲染帧率 */
  const fps = ref(0)

  let mediaSource: MediaSource | null = null
  let sourceBuffer: SourceBuffer | null = null
  let audioSourceBuffer: SourceBuffer | null = null
  let currentAudioCodec = ''
  let ws: WebSocket | null = null
  let pendingQueue: BufferSource[] = []
  let appending = false
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let retryCount = 0
  let currentCodec = ''
  let vfcFrameCount = 0
  let vfcStartTime = 0
  let videoFrameCallbackId: number | null = null
  let lastVfcUpdateTime = 0
  let segmentCount = 0
  let segmentFpsStart = 0
  let videoEventHandlers: Array<{ event: string; handler: EventListener }> = []
  let pendingInit: BufferSource | null = null
  let decodeCheckTimer: ReturnType<typeof setTimeout> | null = null
  let pruning = false
  let appendCount = 0
  const PRUNE_EVERY_N_APPENDS = 8

  /** 设置 video 元素 */
  function setVideo(el: HTMLVideoElement | null) {
    if (videoFrameCallbackId != null && videoRef.value) {
      videoRef.value.cancelVideoFrameCallback?.(videoFrameCallbackId)
      videoFrameCallbackId = null
    }
    if (videoRef.value) {
      for (const { event, handler } of videoEventHandlers) {
        videoRef.value.removeEventListener(event, handler)
      }
      videoEventHandlers = []
    }

    videoRef.value = el

    if (el) {
      bindVideoEvents(el)
      if (mediaSource && !el.src) {
        if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl)
        currentBlobUrl = URL.createObjectURL(mediaSource)
        el.src = currentBlobUrl
      }
      if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
        vfcStartTime = performance.now()
        vfcFrameCount = 0
        const measureFps = () => {
          vfcFrameCount++
          const elapsed = performance.now() - vfcStartTime
          if (elapsed >= 2000) {
            fps.value = Math.round(vfcFrameCount * 1000 / elapsed)
            lastVfcUpdateTime = performance.now()
            vfcFrameCount = 0
            vfcStartTime = performance.now()
          }
          videoFrameCallbackId = el.requestVideoFrameCallback(measureFps)
        }
        videoFrameCallbackId = el.requestVideoFrameCallback(measureFps)
      }
    }
  }

  function bindVideoEvents(el: HTMLVideoElement) {
    /** 播放卡住时立即 seek */
    const onWaiting = () => {
      const video = videoRef.value
      if (!video || !sourceBuffer) return
      const buffered = sourceBuffer.buffered
      if (buffered.length > 0) {
        const end = buffered.end(buffered.length - 1)
        if (end - video.currentTime > 0.02) {
          video.currentTime = end - 0.02
        }
      }
    }

    const onError = () => {
      const err = el.error
      if (err) {
        console.warn(`[fMP4] video error: code=${err.code} ${err.message}`)
        if (err.code >= 3) {
          ws?.close()
          scheduleReconnect()
        }
      }
    }

    const onPlaying = () => { playing.value = true }
    const onPause = () => { playing.value = false }

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

  let currentBlobUrl: string | null = null
  const streamHandle = { pruneBuffer, needsPrune: false }

  function connect() {
    disconnect()
    pendingQueue = []
    pendingInit = null
    appending = false
    pruning = false
    currentCodec = ''
    currentAudioCodec = ''
    vfcFrameCount = 0
    vfcStartTime = performance.now()
    segmentCount = 0
    segmentFpsStart = performance.now()

    mediaSource = new MediaSource()
    if (videoRef.value) {
      if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl)
      currentBlobUrl = URL.createObjectURL(mediaSource)
      videoRef.value.src = currentBlobUrl
    }

    mediaSource.addEventListener('sourceopen', onSourceOpen)
    mediaSource.addEventListener('sourceclose', () => { connected.value = false })
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
      if (decodeCheckTimer) clearTimeout(decodeCheckTimer)
      decodeCheckTimer = setTimeout(() => {
        if (!videoRef.value) return
        if (videoRef.value.videoWidth > 0) return
        console.warn('[fMP4] 5秒内未检测到解码输出，回退到 Canvas')
        failed.value = true
      }, 5000)
    }

    ws.onmessage = (event) => {
      const raw = new Uint8Array(event.data as ArrayBuffer)
      if (raw.length === 0) return

      const type = raw[0]

      if (type === FMP4_TYPE_INIT) {
        if (raw.length < 5) return
        let off = 1
        const videoCodecLen = (raw[off + 1]! << 8) | raw[off]!
        off += 2
        if (raw.length < off + videoCodecLen + 2) return
        const codec = textDecoder.decode(raw.subarray(off, off + videoCodecLen))
        off += videoCodecLen
        const audioCodecLen = (raw[off + 1]! << 8) | raw[off]!
        off += 2
        let audioCodec = ''
        if (audioCodecLen > 0 && raw.length >= off + audioCodecLen) {
          audioCodec = textDecoder.decode(raw.subarray(off, off + audioCodecLen))
        }
        off += audioCodecLen
        const fmp4Data = raw.slice(off).buffer

        const codecChanged = currentCodec !== codec || currentAudioCodec !== audioCodec
        if (codecChanged) {
          currentCodec = codec
          currentAudioCodec = audioCodec
          if (!ensureSourceBuffer(codec, audioCodec)) {
            failed.value = true
            ws?.close()
            return
          }
          pendingInit = null
          doAppend(fmp4Data)
        } else {
          pendingInit = fmp4Data
          pendingQueue = []
        }
      } else if (type === FMP4_TYPE_MEDIA) {
        const fmp4Data = raw.subarray(1)

        segmentCount++
        const segElapsed = performance.now() - segmentFpsStart
        if (segElapsed >= 2000) {
          const segFps = Math.round(segmentCount * 1000 / segElapsed)
          if (segFps > 0 && performance.now() - lastVfcUpdateTime > 4000) {
            fps.value = segFps
          }
          segmentCount = 0
          segmentFpsStart = performance.now()
        }

        if (pendingInit) {
          const initData = pendingInit
          pendingInit = null
          doAppend(initData)
          queueAppend(fmp4Data)
        } else {
          queueAppend(fmp4Data)
        }
      }
    }

    ws.onclose = () => {
      connected.value = false
      scheduleReconnect()
    }

    ws.onerror = () => { ws?.close() }
  }

  function ensureSourceBuffer(codec: string, audioCodec: string): boolean {
    if (!mediaSource || mediaSource.readyState !== 'open') return false

    if (sourceBuffer) {
      sourceBuffer.removeEventListener('updateend', onUpdateEnd)
      if (!sourceBuffer.updating) {
        mediaSource.removeSourceBuffer(sourceBuffer)
      }
      sourceBuffer = null
    }
    if (audioSourceBuffer) {
      audioSourceBuffer.removeEventListener('updateend', onUpdateEnd)
      if (!audioSourceBuffer.updating) {
        mediaSource.removeSourceBuffer(audioSourceBuffer)
      }
      audioSourceBuffer = null
    }

    const hevcCodecs = ['hvc1.1.6.L93.B0', 'hev1.1.6.L93.B0']
    const avcCodecs = ['avc1.640029', 'avc1.64001F', 'avc1.4D401F', 'avc1.42C01E']
    const codecs = codec.startsWith('hvc1') || codec.startsWith('hev1')
      ? [codec, ...hevcCodecs, ...avcCodecs]
      : [codec, ...avcCodecs, ...hevcCodecs]
    const unique = [...new Set(codecs)]

    if (audioCodec) {
      for (const c of unique) {
        const combinedMime = `video/mp4; codecs="${c}, ${audioCodec}"`
        if (MediaSource.isTypeSupported(combinedMime)) {
          try {
            sourceBuffer = mediaSource.addSourceBuffer(combinedMime)
            sourceBuffer.addEventListener('updateend', onUpdateEnd)
            sourceBuffer.addEventListener('error', onBufferError)
            sourceBuffer.mode = 'segments'
            console.debug(`[fMP4] Muxed SourceBuffer created: ${c} + ${audioCodec}`)
            return true
          } catch { /* continue */ }
        }
      }
      console.debug(`[fMP4] 合一 SourceBuffer 不支持，尝试分离模式`)
    }

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
        console.debug(`[fMP4] Video SourceBuffer created: ${c}`)
        break
      } catch { /* continue */ }
    }
    if (!sourceBuffer) {
      console.error('[fMP4] 无法创建 Video SourceBuffer')
      return false
    }

    if (audioCodec && MediaSource.isTypeSupported(`audio/mp4; codecs="${audioCodec}"`)) {
      try {
        audioSourceBuffer = mediaSource.addSourceBuffer(`audio/mp4; codecs="${audioCodec}"`)
        audioSourceBuffer.addEventListener('updateend', onUpdateEnd)
        audioSourceBuffer.mode = 'segments'
        console.debug(`[fMP4] Audio SourceBuffer created: ${audioCodec}`)
      } catch (e) {
        console.warn(`[fMP4] 音频 SourceBuffer 创建失败:`, e)
        audioSourceBuffer = null
      }
    } else if (audioCodec) {
      console.warn(`[fMP4] 浏览器不支持音频 codec ${audioCodec}，仅播放视频`)
    }

    return true
  }

  function queueAppend(data: BufferSource) {
    if (appending || pruning) {
      pendingQueue.push(data)
      if (pendingQueue.length > MAX_PENDING_SEGMENTS) {
        const newest = pendingQueue[pendingQueue.length - 1]!
        pendingQueue = [newest]
      }
      return
    }
    doAppend(data)
  }

  function doAppend(data: BufferSource) {
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
      if (sourceBuffer && e instanceof DOMException && e.name === 'QuotaExceededError') {
        console.warn('[fMP4] QuotaExceeded，清理缓冲区')
        const buf = sourceBuffer.buffered
        if (!sourceBuffer.updating && buf.length > 0 && videoRef.value) {
          const ct = videoRef.value.currentTime
          const removeEnd = ct > buf.start(0) ? ct : buf.end(buf.length - 1)
          if (removeEnd > buf.start(0)) {
            pruning = true
            try { sourceBuffer.remove(buf.start(0), removeEnd) } catch { /* */ }
          }
        }
        pendingQueue = [data]
      }
    }
  }

  function onBufferError(): void {
    console.warn('[fMP4] SourceBuffer error，尝试清理缓冲区')
    if (!sourceBuffer) return
    appending = false
    pruning = false
    pendingQueue = []
    if (!sourceBuffer.updating && mediaSource?.readyState === 'open') {
      const buffered = sourceBuffer.buffered
      if (buffered.length > 0) {
        try { sourceBuffer.remove(buffered.start(0), buffered.end(buffered.length - 1)) } catch { /* */ }
      }
    }
  }

  function onUpdateEnd() {
    const wasAppending = appending
    const wasPruning = pruning
    appending = false
    pruning = false

    /** prune 完成：继续 drain */
    if (wasPruning) {
      drainPending()
      return
    }

    /** append 完成：追赶直播 + 定期 prune */
    if (wasAppending) {
      appendCount++
      catchUpToLive()

      if (appendCount >= PRUNE_EVERY_N_APPENDS) {
        appendCount = 0
        pruneBuffer()
        /** prune 启动了，等 remove 完成后再 drain */
        if (pruning) return
      }
    }

    /** 处理待追加队列 */
    if (pendingQueue.length > 0) {
      drainPending()
    }

    /** 自动播放 */
    if (videoRef.value && videoRef.value.paused && sourceBuffer?.buffered.length) {
      videoRef.value.play().then(() => { playing.value = true }).catch(() => { /* */ })
    }

    /** 分辨率更新 */
    if (videoRef.value) {
      const w = videoRef.value.videoWidth
      const h = videoRef.value.videoHeight
      if (w && h && (videoWidth.value !== w || videoHeight.value !== h)) {
        videoWidth.value = w
        videoHeight.value = h
      }
    }
  }

  function drainPending() {
    if (pendingQueue.length === 0 || !sourceBuffer || sourceBuffer.updating) return
    if (pendingQueue.length === 1) {
      doAppend(pendingQueue.shift()!)
      return
    }
    /** 多段合并 */
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

  /** 追赶直播 */
  function catchUpToLive() {
    const video = videoRef.value
    if (!video || !sourceBuffer) return
    const buffered = sourceBuffer.buffered
    if (buffered.length === 0) return

    const end = buffered.end(buffered.length - 1)
    const delay = end - video.currentTime

    if (delay > LIVE_SEEK_THRESHOLD || delay < -0.3) {
      video.currentTime = end - 0.02
    }
  }

  /** 清除已播放缓冲区 */
  function pruneBuffer() {
    if (!sourceBuffer || !videoRef.value || sourceBuffer.updating || appending || pruning) return
    const buffered = sourceBuffer.buffered
    if (buffered.length === 0) return

    const currentTime = videoRef.value.currentTime

    /** 多 range：清理旧 range */
    if (buffered.length > 1) {
      let activeIdx = -1
      for (let i = 0; i < buffered.length; i++) {
        if (currentTime >= buffered.start(i) && currentTime <= buffered.end(i)) {
          activeIdx = i
          break
        }
      }
      if (activeIdx <= 0) {
        const latestStart = buffered.start(buffered.length - 1)
        if (currentTime < latestStart) {
          pruning = true
          try { sourceBuffer.remove(buffered.start(0), latestStart) } catch { pruning = false }
          return
        }
      }
      if (activeIdx > 0) {
        pruning = true
        try { sourceBuffer.remove(buffered.start(0), buffered.start(activeIdx)) } catch { pruning = false }
        return
      }
    }

    /** 单 range：清理已播放部分 */
    const start = buffered.start(0)
    const behindDuration = currentTime - start
    if (behindDuration > BUFFER_RETAIN_SECONDS + 0.5) {
      pruning = true
      try { sourceBuffer.remove(start, currentTime - BUFFER_RETAIN_SECONDS) } catch { pruning = false }
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer) return
    retryCount++
    if (retryCount >= 5) {
      console.warn('[fMP4] 连续 5 次连接失败，标记为失败')
      failed.value = true
      return
    }
    const delay = Math.min(200 * Math.pow(2, retryCount - 1), 30000)
    console.warn(`[fMP4] ${delay / 1000}s 后重连 (第 ${retryCount} 次)`)
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect() }, delay)
  }

  function disconnect() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
    if (videoFrameCallbackId != null && videoRef.value) {
      try { videoRef.value.cancelVideoFrameCallback?.(videoFrameCallbackId) } catch { /* */ }
      videoFrameCallbackId = null
    }
    if (decodeCheckTimer) { clearTimeout(decodeCheckTimer); decodeCheckTimer = null }
    unregisterStream(streamHandle)
    ws?.close()
    ws = null
    if (sourceBuffer && mediaSource && mediaSource.readyState === 'open') {
      sourceBuffer.removeEventListener('updateend', onUpdateEnd)
      sourceBuffer.removeEventListener('error', onBufferError)
      try { mediaSource.removeSourceBuffer(sourceBuffer) } catch { /* */ }
    }
    sourceBuffer = null
    if (audioSourceBuffer && mediaSource && mediaSource.readyState === 'open') {
      audioSourceBuffer.removeEventListener('updateend', onUpdateEnd)
      try { mediaSource.removeSourceBuffer(audioSourceBuffer) } catch { /* */ }
    }
    audioSourceBuffer = null
    if (mediaSource) {
      mediaSource.removeEventListener('sourceopen', onSourceOpen)
      if (mediaSource.readyState === 'open') mediaSource.endOfStream()
    }
    mediaSource = null
    if (currentBlobUrl) { URL.revokeObjectURL(currentBlobUrl); currentBlobUrl = null }
    currentCodec = ''
    currentAudioCodec = ''
    pendingInit = null
    pendingQueue = []
    appending = false
    pruning = false
    appendCount = 0
    vfcFrameCount = 0
    lastVfcUpdateTime = 0
    segmentCount = 0
    connected.value = false
    playing.value = false
    fps.value = 0
    failed.value = false
  }

  registerStream(streamHandle)

  function pauseWs() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
    ws?.close()
    ws = null
    connected.value = false
  }

  function resumeWs() {
    if (mediaSource && mediaSource.readyState === 'open' && sourceBuffer) {
      const url = authWsUrl(`/api/stream/${cameraId.value}`)
      connectWs(url)
    } else {
      connect()
    }
  }

  /** 页面隐藏/可见 */
  let wasConnectedBeforeHidden = false
  const onVisibilityChange = () => {
    if (document.hidden) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        wasConnectedBeforeHidden = true
        pauseWs()
      }
    } else if (wasConnectedBeforeHidden) {
      wasConnectedBeforeHidden = false
      resumeWs()
    }
  }
  document.addEventListener('visibilitychange', onVisibilityChange)

  /** 视口可见性 */
  let isInViewport = true
  let wasConnectedBeforeHiddenViewport = false

  function setVisible(visible: boolean) {
    if (visible === isInViewport) return
    isInViewport = visible
    if (!visible) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        wasConnectedBeforeHiddenViewport = true
        pauseWs()
      }
    } else if (wasConnectedBeforeHiddenViewport) {
      wasConnectedBeforeHiddenViewport = false
      resumeWs()
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
