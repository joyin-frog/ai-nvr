import { ref } from 'vue'

/** 全局共享时钟文本（所有 CameraView 共用同一个 setInterval） */
const clockText = ref(formatClock())

function formatClock(): string {
  const now = new Date()
  const y = now.getFullYear()
  const mo = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  const h = String(now.getHours()).padStart(2, '0')
  const mi = String(now.getMinutes()).padStart(2, '0')
  const s = String(now.getSeconds()).padStart(2, '0')
  return `${y}-${mo}-${d} ${h}:${mi}:${s}`
}

/** 引用计数：最后一个消费者卸载时清除定时器 */
let refCount = 0
let timer: ReturnType<typeof setInterval> | null = null

function startClock(): void {
  refCount++
  if (!timer) {
    timer = setInterval(() => { clockText.value = formatClock() }, 1000)
  }
}

function stopClock(): void {
  refCount--
  if (refCount <= 0 && timer) {
    clearInterval(timer)
    timer = null
    refCount = 0
  }
}

/** 全局时钟 composable：所有组件共享同一个定时器 */
export function useClock() {
  startClock()
  let stopped = false
  const cleanup = () => {
    if (stopped) return
    stopped = true
    stopClock()
  }
  return { clockText, cleanup }
}
