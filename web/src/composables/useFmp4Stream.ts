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
  /** 清理缓冲区定时器 */
  let pruneTimer: ReturnType<typeof setInterval> | null = null
  /** 当前使用的 codec */
  let currentCodec = ''

  /** 设置 video 元素 */
  function setVideo(el: HTMLVideoElement | null) {
    videoRef.value = el
  }

  /** 连接 fMP4 流 */
  function connect() {
    disconnect()
    pendingQueue = []
    appending = false
    currentCodec = ''

    mediaSource = new MediaSource()
    if (videoRef.value) {
      videoRef.value.src = URL.createObjectURL(mediaSource)
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
        const codec = new TextDecoder().decode(raw.subarray(3, 3 + codecLen))
        const fmp4Data = raw.subarray(3 + codecLen).buffer

        /** codec 变化时需要重建 SourceBuffer */
        if (currentCodec !== codec) {
          currentCodec = codec
          ensureSourceBuffer(codec)
        }
        doAppend(fmp4Data)
      } else if (type === FMP4_TYPE_MEDIA) {
        const fmp4Data = raw.subarray(1).buffer
        queueAppend(fmp4Data)
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

  /** 创建或重建 SourceBuffer */
  function ensureSourceBuffer(codec: string) {
    if (!mediaSource || mediaSource.readyState !== 'open') return

    /** 移除旧的 SourceBuffer */
    if (sourceBuffer) {
      sourceBuffer.removeEventListener('updateend', onUpdateEnd)
      if (!sourceBuffer.updating) {
        mediaSource.removeSourceBuffer(sourceBuffer)
      }
      sourceBuffer = null
    }

    /** 优先使用服务器提供的 codec，失败则回退 */
    const codecs = [codec, 'avc1.640029', 'avc1.64001F', 'avc1.4D401F', 'avc1.42C01E']
    /** 去重 */
    const unique = [...new Set(codecs)]

    for (const c of unique) {
      try {
        sourceBuffer = mediaSource.addSourceBuffer(`video/mp4; codecs="${c}"`)
        sourceBuffer.addEventListener('updateend', onUpdateEnd)
        sourceBuffer.addEventListener('error', () => { /* ignore */ })
        sourceBuffer.mode = 'segments'
        console.log(`[fMP4] SourceBuffer created: ${c}`)
        return
      } catch {
        /** codec 不支持，尝试下一个 */
      }
    }
    console.error('[fMP4] 无法创建 SourceBuffer')
  }

  function queueAppend(data: ArrayBuffer) {
    if (appending) {
      pendingQueue.push(data)
      return
    }
    doAppend(data)
  }

  function doAppend(data: ArrayBuffer) {
    if (!sourceBuffer || sourceBuffer.updating) {
      pendingQueue.push(data)
      return
    }
    appending = true
    try {
      sourceBuffer.appendBuffer(data)
    } catch {
      appending = false
    }
  }

  function onUpdateEnd() {
    appending = false

    /** 处理队列中的段 */
    if (pendingQueue.length > 0) {
      /** 合并所有 pending 段一次 append */
      const total = pendingQueue.reduce((sum, b) => sum + b.byteLength, 0)
      const merged = new Uint8Array(total)
      let offset = 0
      for (const buf of pendingQueue) {
        merged.set(new Uint8Array(buf), offset)
        offset += buf.byteLength
      }
      pendingQueue = []
      doAppend(merged.buffer)
    }

    /** 清除已播放缓冲区 */
    pruneBuffer()

    /** 自动播放 */
    if (videoRef.value && videoRef.value.paused && sourceBuffer?.buffered.length) {
      videoRef.value.play().then(() => {
        playing.value = true
      }).catch(() => { /* autoplay blocked */ })
    }

    /** 更新视频分辨率 */
    if (videoRef.value) {
      videoWidth.value = videoRef.value.videoWidth
      videoHeight.value = videoRef.value.videoHeight
    }
  }

  /** 清除已播放的缓冲区，防止内存增长 */
  function pruneBuffer() {
    if (!sourceBuffer || !videoRef.value || sourceBuffer.updating) return
    const buffered = sourceBuffer.buffered
    if (buffered.length > 0) {
      const currentTime = videoRef.value.currentTime
      const start = buffered.start(0)
      /** 保留当前播放位置前 2 秒 */
      if (currentTime - start > 2) {
        try {
          sourceBuffer.remove(start, currentTime - 2)
        } catch { /* ignore */ }
      }
    }
  }

  /** 重连 */
  function scheduleReconnect() {
    if (reconnectTimer) return
    retryCount++
    const delay = Math.min(1000 * Math.pow(2, retryCount - 1), 30000)
    console.log(`[fMP4] ${delay / 1000}s 后重连 (第 ${retryCount} 次)`)
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
    if (pruneTimer) {
      clearInterval(pruneTimer)
      pruneTimer = null
    }
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
    currentCodec = ''
    pendingQueue = []
    appending = false
    connected.value = false
    playing.value = false
  }

  /** 定期清理缓冲区 */
  pruneTimer = setInterval(pruneBuffer, 5000)

  onUnmounted(() => {
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
  }
}
