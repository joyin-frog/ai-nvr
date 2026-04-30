/** 检测结果类型 */
export interface Detection {
  label: string
  score: number
  box: { xmin: number; ymin: number; xmax: number; ymax: number }
}

/** 事件载荷类型 */
export interface EventMap {
  frame: { cameraId: string; timestamp: number; image: string }
  motion: { cameraId: string; ratio: number; timestamp: number }
  detect: { cameraId: string; timestamp: number; detections: Detection[] }
  'camera:online': { cameraId: string }
  'camera:offline': { cameraId: string }
}

/** 事件回调 */
type EventCallback<T extends keyof EventMap> = (payload: EventMap[T]) => void

/**
 * 事件 WebSocket 客户端
 * 连接后端 /api/events，自动重连
 */
export class EventClient {
  private ws: WebSocket | null = null
  private listeners = new Map<string, Set<EventCallback<keyof EventMap>>>()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private url: string

  constructor(url?: string) {
    if (url) {
      this.url = url
    } else if (import.meta.env.DEV) {
      /** 开发环境直接连后端，避免 Vite WS 代理不兼容 */
      this.url = 'ws://localhost:3100/api/events'
    } else {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      this.url = `${protocol}//${location.host}/api/events`
    }
  }

  /** 连接 */
  connect(): void {
    this.ws = new WebSocket(this.url)

    this.ws.onopen = () => {
      console.log('[EventClient] 已连接')
    }

    this.ws.onmessage = (e) => {
      try {
        const { event, ...payload } = JSON.parse(e.data as string)
        this.dispatch(event, payload)
      } catch {
        // ignore
      }
    }

    this.ws.onclose = () => {
      console.log('[EventClient] 断开，3 秒后重连')
      this.scheduleReconnect()
    }

    this.ws.onerror = () => {
      this.ws?.close()
    }
  }

  /** 订阅事件 */
  on<T extends keyof EventMap>(event: T, cb: EventCallback<T>): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set())
    }
    const set = this.listeners.get(event)!
    set.add(cb as EventCallback<keyof EventMap>)
    return () => set.delete(cb as EventCallback<keyof EventMap>)
  }

  /** 断开 */
  disconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.ws?.close()
    this.ws = null
  }

  private dispatch(event: string, payload: unknown): void {
    const set = this.listeners.get(event)
    if (!set) return
    for (const cb of set) {
      try { (cb as (p: unknown) => void)(payload) } catch { /* */ }
    }
  }

  private scheduleReconnect(): void {
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, 3000)
  }
}
