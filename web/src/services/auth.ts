import { backendUrl, backendWsUrl } from './backend'

/** Token 存储键 */
const TOKEN_KEY = "nvr_token"

/** 获取存储的 Token */
export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? ""
}

/** 保存 Token */
export function setToken(token: string): void {
  if (token) {
    localStorage.setItem(TOKEN_KEY, token)
  } else {
    localStorage.removeItem(TOKEN_KEY)
  }
}

/** 清除 Token */
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
}

/** 检查是否启用了认证 */
export async function isAuthEnabled(): Promise<boolean> {
  const res = await fetch(backendUrl("/api/auth/check"))
  if (!res.ok) return false
  const data = await res.json()
  return data.enabled === true
}

/** 登录验证 */
export async function login(token: string): Promise<boolean> {
  const res = await fetch(backendUrl("/api/auth/login"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  })
  if (res.ok) {
    setToken(token)
    return true
  }
  return false
}

/** 带 Token 的 fetch 封装 */
export async function authFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const token = getToken()
  const headers = new Headers(init?.headers)
  if (token) {
    headers.set("Authorization", `Bearer ${token}`)
  }
  /** 相对路径转为后端完整 URL */
  const url = typeof input === 'string' && input.startsWith('/') ? backendUrl(input) : input
  const res = await fetch(url, { ...init, headers })
  if (res.status === 401) {
    clearToken()
    location.reload()
  }
  return res
}

/** 带 Token 的 WebSocket URL */
export function authWsUrl(path: string): string {
  const url = backendWsUrl(path)
  const token = getToken()
  if (!token) return url
  const sep = url.includes("?") ? "&" : "?"
  return `${url}${sep}token=${encodeURIComponent(token)}`
}

/** 给 URL 附加 token 参数（用于 video src / 下载链接等非 fetch 场景） */
export function authUrl(path: string): string {
  const url = backendUrl(path)
  const token = getToken()
  if (!token) return url
  const sep = url.includes("?") ? "&" : "?"
  return `${url}${sep}token=${encodeURIComponent(token)}`
}
