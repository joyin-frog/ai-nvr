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

      /** 缓冲区 */
      let buffer = new Uint8Array(0)
      /** boundary 的字节序列 */
      const boundaryBytes = new TextEncoder().encode(boundary)

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        /** 追加到缓冲区 */
        const newBuf = new Uint8Array(buffer.length + value.length)
        newBuf.set(buffer)
        newBuf.set(value, buffer.length)
        buffer = newBuf

        /** 解析帧：找 boundary → 解析 Content-Length → 提取 JPEG 数据 */
        while (buffer.length > 0) {
          /** 找 boundary */
          const boundaryPos = findBytes(buffer, boundaryBytes)
          if (boundaryPos === -1) break

          /** 跳过 boundary + \r\n */
          let headerStart = boundaryPos + boundaryBytes.length
          if (headerStart < buffer.length && buffer[headerStart] === 0x0d) headerStart++
          if (headerStart < buffer.length && buffer[headerStart] === 0x0a) headerStart++

          /** 找 header 结束（\r\n\r\n） */
          const headerEndPos = findDoubleCRLF(buffer, headerStart)
          if (headerEndPos === -1) break

          /** 解析 Content-Length */
          const headerStr = new TextDecoder().decode(buffer.slice(headerStart, headerEndPos))
          const clMatch = headerStr.match(/Content-Length:\s*(\d+)/i)
          if (!clMatch) {
            /** 无 Content-Length，跳过这帧 */
            buffer = buffer.slice(headerEndPos + 4)
            continue
          }
          const contentLength = parseInt(clMatch[1]!, 10)

          /** 数据起始位置 */
          const dataStart = headerEndPos + 4
          /** 数据结束位置（+ \r\n） */
          const dataEnd = dataStart + contentLength

          if (buffer.length < dataEnd + 2) break

          /** 提取 JPEG 数据 */
          const jpegData = buffer.slice(dataStart, dataEnd).buffer as ArrayBuffer
          onFrame(jpegData)

          /** 移除已处理的数据（跳过末尾 \r\n） */
          let nextStart = dataEnd
          if (nextStart < buffer.length && buffer[nextStart] === 0x0d) nextStart++
          if (nextStart < buffer.length && buffer[nextStart] === 0x0a) nextStart++
          buffer = buffer.slice(nextStart)
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
function findDoubleCRLF(buf: Uint8Array, start: number): number {
  for (let i = start; i < buf.length - 3; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a && buf[i + 2] === 0x0d && buf[i + 3] === 0x0a) {
      return i
    }
  }
  return -1
}
