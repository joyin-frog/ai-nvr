import { ref, onUnmounted, type Ref } from 'vue'
import { authWsUrl } from '../services/auth'

/**
 * fMP4/MSE 流播放器
 * 通过 WebSocket 接收 fMP4 段，用 MediaSource + <video> 硬件解码
 * 零 CPU 解码开销，GPU 原生渲染
 */
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
  /** init segment 是否已接收 */
  let initReceived = false
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

  /** 设置 video 元素 */
  function setVideo(el: HTMLVideoElement | null) {
    videoRef.value = el
  }

  /** 连接 fMP4 流 */
  function connect() {
    disconnect()
    initReceived = false
    pendingQueue = []
    appending = false

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
      const data = event.data as ArrayBuffer

      if (!initReceived) {
        /** 第一条消息是 init segment (ftyp + moov) */
        initReceived = true
        initSourceBuffer(data)
        /** append init segment */
        doAppend(data)
      } else {
        /** media segment */
        queueAppend(data)
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

  /** 从 init segment 创建 SourceBuffer */
  function initSourceBuffer(_initData: ArrayBuffer) {
    if (!mediaSource || mediaSource.readyState !== 'open') return

    /** 尝试常见 H.264 codec */
    const codecs = [
      'avc1.640029',  // High 4.1
      'avc1.64001F',  // High 3.1
      'avc1.4D401F',  // Main 3.1
      'avc1.42C01E',  // Baseline 3.0
    ]

    for (const codec of codecs) {
      try {
        sourceBuffer = mediaSource.addSourceBuffer(`video/mp4; codecs="${codec}"`)
        sourceBuffer.addEventListener('updateend', onUpdateEnd)
        sourceBuffer.addEventListener('error', () => { /* ignore */ })
        sourceBuffer.mode = 'segments'
        console.log(`[fMP4] SourceBuffer created: ${codec}`)
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
    initReceived = false
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
