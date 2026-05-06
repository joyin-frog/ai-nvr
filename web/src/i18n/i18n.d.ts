/** vue-i18n 类型增强：让 t() 调用得到 key 的类型检查 */
import type zhCN from './zh-CN'

type MessageSchema = typeof zhCN

declare module 'vue-i18n' {
  export interface DefineLocaleMessage extends MessageSchema {}
}
