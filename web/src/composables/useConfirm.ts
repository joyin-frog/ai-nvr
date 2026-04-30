import { ref } from 'vue'

/** 确认弹窗状态 */
const confirmState = ref<{
  message: string
  resolve: (value: boolean) => void
} | null>(null)

/** 请求确认，返回 Promise<boolean> */
export function confirmDialog(message: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    confirmState.value = { message, resolve }
  })
}

/** ConfirmDialog 组件使用此状态 */
export { confirmState }

/** 关闭弹窗并返回结果 */
export function resolveConfirm(result: boolean) {
  if (confirmState.value) {
    const { resolve } = confirmState.value
    confirmState.value = null
    resolve(result)
  }
}
