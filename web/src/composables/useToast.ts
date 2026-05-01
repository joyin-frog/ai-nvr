import { ref } from 'vue'

/** Toast 通知项 */
interface ToastItem {
  id: number
  message: string
  type: 'success' | 'error' | 'warning' | 'info'
  /** 自动关闭时间（ms），0=不自动关闭 */
  duration: number
}

/** 全局 toast 列表（非响应式内部管理，ref 仅用于触发渲染） */
const toasts = ref<ToastItem[]>([])
let nextId = 0

/** 默认自动关闭时间 */
const DEFAULT_DURATION = 4000

/**
 * 全局 Toast 通知
 * 提供轻量级的成功/错误/警告提示，替代 alert() 和静默 catch
 */
export function useToast() {
  function show(message: string, type: ToastItem['type'] = 'info', duration = DEFAULT_DURATION) {
    const id = nextId++
    toasts.value.push({ id, message, type, duration })
    if (duration > 0) {
      setTimeout(() => dismiss(id), duration)
    }
  }

  function success(message: string) { show(message, 'success') }
  function error(message: string) { show(message, 'error', 6000) }
  function warning(message: string) { show(message, 'warning', 5000) }
  function info(message: string) { show(message, 'info') }

  function dismiss(id: number) {
    const idx = toasts.value.findIndex(t => t.id === id)
    if (idx >= 0) toasts.value.splice(idx, 1)
  }

  function clear() {
    toasts.value.splice(0)
  }

  return { toasts, show, success, error, warning, info, dismiss, clear }
}
