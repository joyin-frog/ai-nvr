import { onMounted, onUnmounted } from 'vue'

/** 快捷键定义 */
interface KeyBinding {
  /** 键值（KeyboardEvent.key） */
  key: string
  /** 是否需要 Alt */
  alt?: boolean
  /** 是否需要 Ctrl/Meta */
  ctrl?: boolean
  /** 回调 */
  handler: () => void
  /** 描述（用于帮助提示） */
  description: string
}

/** 全局快捷键注册表 */
const registry: KeyBinding[] = []

/** 注册快捷键 */
export function registerShortcut(binding: KeyBinding): () => void {
  registry.push(binding)
  return () => {
    const idx = registry.indexOf(binding)
    if (idx >= 0) registry.splice(idx, 1)
  }
}

/** 全局键盘事件处理器 */
function onKeydown(e: KeyboardEvent) {
  /** 输入框中不触发快捷键 */
  const tag = (e.target as HTMLElement)?.tagName
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return

  for (const binding of registry) {
    if (e.key !== binding.key) continue
    if (!!binding.alt !== e.altKey) continue
    if (!!binding.ctrl !== (e.ctrlKey || e.metaKey)) continue

    e.preventDefault()
    binding.handler()
    return
  }
}

/** 获取所有已注册的快捷键 */
export function getShortcuts(): Array<{ key: string; alt: boolean; ctrl: boolean; description: string }> {
  return registry.map(b => ({ key: b.key, alt: !!b.alt, ctrl: !!b.ctrl, description: b.description }))
}

/** 在组件挂载时启用全局快捷键监听 */
let listenerActive = false

export function useKeyboardShortcuts() {
  onMounted(() => {
    if (!listenerActive) {
      window.addEventListener("keydown", onKeydown)
      listenerActive = true
    }
  })

  onUnmounted(() => {
    /** 只有根组件卸载时才移除 */
  })
}
