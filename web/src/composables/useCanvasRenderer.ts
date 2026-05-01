import { ref, onUnmounted, type Ref } from 'vue'

/** 叠加层绘制回调 */
export type OverlayDrawFn = (ctx: CanvasRenderingContext2D, width: number, height: number) => void

/**
 * Canvas 帧渲染器
 * 用 createImageBitmap + Canvas 2D 替代 Blob URL + img 标签
 * 避免每帧创建/销毁 Blob URL，用 rAF 对齐屏幕刷新率
 */
export function useCanvasRenderer() {
  /** 待渲染的 ImageBitmap（rAF 消费后置 null） */
  let pendingBitmap: ImageBitmap | null = null
  /** rAF ID */
  let rafId: number | null = null
  /** Canvas 2D 上下文 */
  let ctx: CanvasRenderingContext2D | null = null
  /** 是否已激活 rAF 循环 */
  let loopActive = false
  /** 当前显示的帧宽度（用于检测分辨率变化） */
  let lastWidth = 0
  let lastHeight = 0
  /** 是否正在解码中（防止 decode Promise 堆积） */
  let decoding = false
  /** 解码期间最新到达的帧数据（确保解码完后处理最新帧） */
  let latestBuffer: ArrayBuffer | null = null
  /** 叠加层绘制回调（检测框、标签等） */
  let overlayFn: OverlayDrawFn | null = null
  /** rAF 帧前回调（用于 poll 帧缓存，替代 Vue watcher） */
  let framePollFn: (() => void) | null = null
  /** 实际渲染帧计数（1秒滑动窗口） */
  let renderCount = 0
  let renderFpsStart = 0
  /** 最近一秒的实际渲染帧率 */
  let renderFps = 0

  /** Canvas 元素引用 */
  const canvasRef: Ref<HTMLCanvasElement | null> = ref(null)

  /** 设置 Canvas 元素 */
  function setCanvas(el: HTMLCanvasElement | null) {
    canvasRef.value = el
    ctx = el ? el.getContext('2d') : null
  }

  /** 设置叠加层绘制函数 */
  function setOverlay(fn: OverlayDrawFn | null) {
    overlayFn = fn
  }

  /** 设置帧 poll 回调（在每次 rAF 前调用，用于从帧缓存取帧） */
  function setFramePollFn(fn: (() => void) | null) {
    framePollFn = fn
  }

  /** rAF 渲染循环 */
  function renderLoop() {
    if (!loopActive) return
    /** 在渲染前调用帧 poll 回调（消费 ws-frame-cache） */
    if (framePollFn) framePollFn()

    if (pendingBitmap) {
      /** 页面不可见时跳过渲染，释放 bitmap 节省 GPU 内存 */
      if (document.hidden) {
        pendingBitmap.close()
        pendingBitmap = null
      } else if (ctx && canvasRef.value) {
        const bitmap = pendingBitmap
        pendingBitmap = null

        /** 分辨率变化时调整 Canvas 尺寸 */
        if (bitmap.width !== lastWidth || bitmap.height !== lastHeight) {
          canvasRef.value.width = bitmap.width
          canvasRef.value.height = bitmap.height
          lastWidth = bitmap.width
          lastHeight = bitmap.height
        }

        ctx.drawImage(bitmap, 0, 0)
        bitmap.close()

        /** 渲染帧率统计 */
        renderCount++
        const now = performance.now()
        if (now - renderFpsStart >= 1000) {
          renderFps = renderCount * 1000 / (now - renderFpsStart)
          renderCount = 0
          renderFpsStart = now
        }

        /** 绘制叠加层（检测框等） */
        if (overlayFn) {
          overlayFn(ctx, lastWidth, lastHeight)
        }
      }
    }
    rafId = requestAnimationFrame(renderLoop)
  }

  /** 启动渲染循环 */
  function startLoop() {
    if (loopActive) return
    loopActive = true
    rafId = requestAnimationFrame(renderLoop)
  }

  /** 停止渲染循环 */
  function stopLoop() {
    loopActive = false
    if (rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
    if (pendingBitmap) {
      pendingBitmap.close()
      pendingBitmap = null
    }
  }

  /** 解码一帧并放入 pending */
  async function decodeAndQueue(buffer: ArrayBuffer) {
    decoding = true
    try {
      const bitmap = await createImageBitmap(
        new Blob([buffer], { type: 'image/jpeg' }),
        { premultiplyAlpha: 'none', colorSpaceConversion: 'none' },
      )
      if (pendingBitmap) pendingBitmap.close()
      pendingBitmap = bitmap
    } catch {
      /** 解码失败忽略 */
    }
    /** 解码期间如果有新帧到达，立即处理最新的 */
    if (latestBuffer) {
      const next = latestBuffer
      latestBuffer = null
      decodeAndQueue(next)
    } else {
      decoding = false
    }
  }

  /**
   * 喂入一帧 JPEG ArrayBuffer
   * 解码锁防止并发 createImageBitmap 堆积
   */
  function feedFrame(jpegArrayBuffer: ArrayBuffer) {
    if (decoding) {
      /** 正在解码 → 只保留最新一帧，等解码完后处理 */
      latestBuffer = jpegArrayBuffer
      return
    }
    decodeAndQueue(jpegArrayBuffer)
  }

  /** 截取当前 Canvas 为 JPEG Blob（用于截图下载） */
  async function captureJpeg(): Promise<Blob | null> {
    if (!canvasRef.value) return null
    return new Promise((resolve) => {
      canvasRef.value!.toBlob((blob) => resolve(blob), 'image/jpeg', 0.92)
    })
  }

  /** 获取当前帧尺寸 */
  function getFrameSize(): { width: number; height: number } {
    return { width: lastWidth, height: lastHeight }
  }

  /** 获取实际渲染帧率（每秒实际渲染的帧数） */
  function getRenderFps(): number {
    return renderFps
  }

  onUnmounted(() => {
    stopLoop()
  })

  return {
    canvasRef,
    setCanvas,
    setOverlay,
    setFramePollFn,
    feedFrame,
    startLoop,
    stopLoop,
    captureJpeg,
    getFrameSize,
    getRenderFps,
  }
}
