/** 后端地址配置 */

/** VITE_BACKEND_URL 在 .env 或 vite 配置中设置，默认当前 origin */
const DEFAULT_BACKEND = import.meta.env.VITE_BACKEND_URL || ''
const BACKEND_KEY = 'nvr_backend_url'

/** 获取后端基础地址 */
export function getBackendUrl(): string {
  const stored = localStorage.getItem(BACKEND_KEY)
  if (stored) return stored.replace(/\/+$/, '')
  if (DEFAULT_BACKEND) return DEFAULT_BACKEND.replace(/\/+$/, '')
  return `${location.protocol}//${location.host}`
}

/** 设置后端基础地址 */
export function setBackendUrl(url: string): void {
  if (url) {
    localStorage.setItem(BACKEND_KEY, url.replace(/\/+$/, ''))
  } else {
    localStorage.removeItem(BACKEND_KEY)
  }
}

/** 构建后端 API 请求 URL */
export function backendUrl(path: string): string {
  const base = getBackendUrl()
  return `${base}${path.startsWith('/') ? path : '/' + path}`
}

/** 构建 WebSocket URL */
export function backendWsUrl(path: string): string {
  const base = getBackendUrl()
  const wsBase = base.replace(/^http/, 'ws')
  return `${wsBase}${path.startsWith('/') ? path : '/' + path}`
}
