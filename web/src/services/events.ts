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
 * 二进制协议：[4字节头长度 LE uint32][JSON 头][可选二进制帧数据]
 * frame 事件的二进制部分是 JPEG，会被转为 data URL
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
      this.url = 'ws://localhost:3100/api/events'
    } else {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      this.url = `${protocol}//${location.host}/api/events`
    }
  }

  /** 连接 */
  connect(): void {
    this.ws = new WebSocket(this.url)
    /** 使用二进制模式 */
    this.ws.binaryType = 'arraybuffer'

    this.ws.onopen = () => {
      console.log('[EventClient] 已连接')
    }

    this.ws.onmessage = (e) => {
      this.handleMessage(e.data)
    }

    this.ws.onclose = () => {
      console.log('[EventClient] 断开，3 秒后重连')
      this.scheduleReconnect()
    }

    this.ws.onerror = () => {
      this.ws?.close()
    }
  }

  /** 解析二进制协议消息 */
  private handleMessage(data: ArrayBuffer | string): void {
    /** 兼容文本消息（向后兼容） */
    if (typeof data === 'string') {
      try {
        const { event, ...payload } = JSON.parse(data)
        this.dispatch(event, payload)
      } catch { /* ignore */ }
      return
    }

    const buf = new Uint8Array(data)
    if (buf.length < 4) return

    /** 读取 4 字节头长度 */
    const headerLen = buf[0]! | (buf[1]! << 8) | (buf[2]! << 16) | (buf[3]! << 24)
    if (buf.length < 4 + headerLen) return

    /** 解析 JSON 头 */
    const headerBytes = buf.slice(4, 4 + headerLen)
    let header: Record<string, unknown>
    try {
      header = JSON.parse(new TextDecoder().decode(headerBytes))
    } catch {
      return
    }

    const event = header.event as string
    if (!event) return

    /** 构建载荷 */
    const payload: Record<string, unknown> = { ...header }
    delete payload.event

    /** frame 事件：提取二进制 JPEG，转为 data URL */
    if (event === 'frame' && buf.length > 4 + headerLen) {
      const jpegBytes = buf.slice(4 + headerLen)
      const blob = new Blob([jpegBytes], { type: 'image/jpeg' })
      payload.image = URL.createObjectURL(blob)
    }

    this.dispatch(event, payload)
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
