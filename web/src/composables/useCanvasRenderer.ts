import { ref, onUnmounted, type Ref } from 'vue'

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

  /** Canvas 元素引用 */
  const canvasRef: Ref<HTMLCanvasElement | null> = ref(null)

  /** 设置 Canvas 元素 */
  function setCanvas(el: HTMLCanvasElement | null) {
    canvasRef.value = el
    ctx = el ? el.getContext('2d') : null
  }

  /** rAF 渲染循环 */
  function renderLoop() {
    if (!loopActive) return
    if (pendingBitmap && ctx && canvasRef.value) {
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
    }
    /** 无论是否有帧都保持 rAF 循环（低功耗：无帧时只空转） */
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

  /**
   * 喂入一帧 JPEG ArrayBuffer
   * createImageBitmap 解码后放入 pending，由 rAF 消费
   * 如果 pending 还没被消费（渲染跟不上），直接替换（跳帧）
   */
  async function feedFrame(jpegArrayBuffer: ArrayBuffer) {
    try {
      const bitmap = await createImageBitmap(
        new Blob([jpegArrayBuffer], { type: 'image/jpeg' }),
        { premultiplyAlpha: 'none', colorSpaceConversion: 'none' },
      )
      /** 替换 pending（跳帧策略：只渲染最新帧） */
      if (pendingBitmap) pendingBitmap.close()
      pendingBitmap = bitmap
    } catch {
      /** 解码失败忽略（可能是不完整帧） */
    }
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

  onUnmounted(() => {
    stopLoop()
  })

  return {
    canvasRef,
    setCanvas,
    feedFrame,
    startLoop,
    stopLoop,
    captureJpeg,
    getFrameSize,
  }
}
