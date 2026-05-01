import { ref, onUnmounted } from 'vue'
import { getToken } from '../services/auth'

/**
 * MJPEG 流拉取器
 * 用 fetch + ReadableStream 手动解析 multipart/x-mixed-replace 帧
 * 返回的帧数据直接喂给 Canvas 渲染器，避免 <img> Blob URL 开销
 */
export function useMjpegStream() {
  /** 是否正在拉取 */
  const fetching = ref(false)
  /** AbortController（用于断开流） */
  let abortController: AbortController | null = null

  /**
   * 开始拉取 MJPEG 流
   * @param url 流地址
   * @param onFrame 收到一帧 JPEG 的回调
   */
  async function startFetch(url: string, onFrame: (jpeg: ArrayBuffer) => void): Promise<void> {
    stopFetch()
    abortController = new AbortController()
    fetching.value = true

    try {
      const headers: Record<string, string> = {}
      const token = getToken()
      if (token) headers['Authorization'] = `Bearer ${token}`

      const res = await fetch(url, { signal: abortController.signal, headers })
      if (!res.ok || !res.body) {
        fetching.value = false
        return
      }

      const reader = res.body.getReader()
      /** 从 Content-Type 提取 boundary */
      const contentType = res.headers.get('Content-Type') ?? ''
      const boundaryMatch = contentType.match(/boundary=([^\s;]+)/)
      const boundary = boundaryMatch ? boundaryMatch[1]! : '--nvrboundary'

      /** 增长式缓冲区：避免每帧复制整个数组 */
      const CHUNK = 65536
      let buf = new Uint8Array(CHUNK)
      let bufLen = 0
      /** boundary 的字节序列 */
      const boundaryBytes = new TextEncoder().encode(boundary)

      /** 确保缓冲区有足够空间 */
      function ensureCapacity(needed: number): void {
        if (bufLen + needed <= buf.length) return
        let newSize = buf.length
        while (newSize < bufLen + needed) newSize *= 2
        const newBuf = new Uint8Array(newSize)
        newBuf.set(buf.subarray(0, bufLen))
        buf = newBuf
      }

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        ensureCapacity(value.length)
        buf.set(value, bufLen)
        bufLen += value.length

        /** 解析帧：找 boundary → 解析 Content-Length → 提取 JPEG 数据 */
        let consumed = 0
        while (consumed < bufLen) {
          const view = buf.subarray(consumed, bufLen)

          /** 找 boundary */
          const boundaryPos = findBytes(view, boundaryBytes)
          if (boundaryPos === -1) break

          /** 跳过 boundary + \r\n */
          let headerStart = boundaryPos + boundaryBytes.length
          if (consumed + headerStart < bufLen && buf[consumed + headerStart] === 0x0d) headerStart++
          if (consumed + headerStart < bufLen && buf[consumed + headerStart] === 0x0a) headerStart++

          /** 找 header 结束（\r\n\r\n） */
          const absHeaderStart = consumed + headerStart
          const headerEndPos = findDoubleCRLF(buf, absHeaderStart, bufLen)
          if (headerEndPos === -1) break

          /** 解析 Content-Length */
          const headerStr = new TextDecoder().decode(buf.subarray(absHeaderStart, headerEndPos))
          const clMatch = headerStr.match(/Content-Length:\s*(\d+)/i)
          if (!clMatch) {
            consumed = headerEndPos + 4
            continue
          }
          const contentLength = parseInt(clMatch[1]!, 10)

          /** 数据起始位置 */
          const dataStart = headerEndPos + 4
          /** 需要的总长度：header end + CRLF + contentLength + CRLF */
          if (bufLen < dataStart + contentLength + 2) break

          /** 提取 JPEG 数据（零拷贝：直接用 buffer 的子集创建 ArrayBuffer） */
          const jpegSlice = buf.subarray(dataStart, dataStart + contentLength)
          const jpegData = new ArrayBuffer(jpegSlice.length)
          new Uint8Array(jpegData).set(jpegSlice)
          onFrame(jpegData)

          /** 跳过数据 + 尾部 \r\n */
          consumed = dataStart + contentLength
          if (consumed < bufLen && buf[consumed] === 0x0d) consumed++
          if (consumed < bufLen && buf[consumed] === 0x0a) consumed++
        }

        /** 压缩缓冲区：把未消费的数据移到前面 */
        if (consumed > 0) {
          buf.copyWithin(0, consumed, bufLen)
          bufLen -= consumed
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        console.error('[MjpegStream] 拉取错误:', (err as Error).message)
      }
    } finally {
      fetching.value = false
    }
  }

  /** 断开流 */
  function stopFetch(): void {
    if (abortController) {
      abortController.abort()
      abortController = null
    }
    fetching.value = false
  }

  onUnmounted(() => {
    stopFetch()
  })

  return { fetching, startFetch, stopFetch }
}

/** 在 Uint8Array 中搜索字节序列 */
function findBytes(buf: Uint8Array, target: Uint8Array): number {
  if (target.length === 0) return 0
  outer: for (let i = 0; i <= buf.length - target.length; i++) {
    for (let j = 0; j < target.length; j++) {
      if (buf[i + j] !== target[j]) continue outer
    }
    return i
  }
  return -1
}

/** 找 \r\n\r\n 的位置 */
function findDoubleCRLF(buf: Uint8Array, start: number, end: number): number {
  for (let i = start; i < end - 3; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a && buf[i + 2] === 0x0d && buf[i + 3] === 0x0a) {
      return i
    }
  }
  return -1
}
