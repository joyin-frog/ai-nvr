import { backendWsUrl } from './backend'

/** 检测结果类型 */
export interface Detection {
  label: string
  score: number
  box: { xmin: number; ymin: number; xmax: number; ymax: number }
  trackId?: number
}

/** 事件载荷类型 */
export interface EventMap {
  frame: { cameraId: string; timestamp: number; jpegData: ArrayBuffer }
  motion: { cameraId: string; ratio: number; timestamp: number }
  detect: { cameraId: string; timestamp: number; detections: Detection[]; changed?: boolean; inferMs?: number }
  'camera:online': { cameraId: string }
  'camera:offline': { cameraId: string }
  'camera:lowfps': { cameraId: string; fps: number }
  alert: { ruleId: number; ruleName: string; cameraId: string; timestamp: number; detail: string }
  'track:appeared': { cameraId: string; timestamp: number; trackId: number; label: string; score: number }
  'track:disappeared': { cameraId: string; timestamp: number; trackId: number; label: string }
  'track:label-updated': { cameraId: string; trackId: number; name: string }
}

/** 事件回调 */
type EventCallback<T extends keyof EventMap> = (payload: EventMap[T]) => void

/** 连接状态 */
export type ConnectionState = 'connected' | 'connecting' | 'disconnected'

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
  /** 重连次数（用于指数退避） */
  private reconnectAttempts = 0
  /** 最大重连间隔（秒） */
  private static readonly MAX_BACKOFF = 30
  /** 已订阅的摄像头 ID 集合 */
  private subscribedCameras = new Set<string>()
  /** 连接状态监听器 */
  private stateListeners = new Set<(state: ConnectionState) => void>()
  private _state: ConnectionState = 'disconnected'

  constructor(url?: string) {
    if (url) {
      this.url = url
    } else {
      this.url = backendWsUrl('/api/events')
    }
  }

  /** 获取当前连接状态 */
  get state(): ConnectionState {
    return this._state
  }

  /** 监听连接状态变化 */
  onStateChange(cb: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(cb)
    return () => this.stateListeners.delete(cb)
  }

  private setState(state: ConnectionState): void {
    this._state = state
    for (const cb of this.stateListeners) {
      try { cb(state) } catch { /* */ }
    }
  }

  /** 连接 */
  connect(): void {
    this.setState('connecting')
    this.ws = new WebSocket(this.url)
    /** 使用二进制模式 */
    this.ws.binaryType = 'arraybuffer'

    this.ws.onopen = () => {
      console.log('[EventClient] 已连接')
      this.reconnectAttempts = 0
      this.setState('connected')
      /** 连接后发送摄像头订阅（减少无关帧带宽） */
      if (this.subscribedCameras.size > 0) {
        this.sendSubscribe()
      }
    }

    this.ws.onmessage = (e) => {
      this.handleMessage(e.data)
    }

    this.ws.onclose = () => {
      this.setState('disconnected')
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
        /** 心跳 ping：自动回复 pong */
        if (event === 'ping') {
          this.ws?.send(JSON.stringify({ type: 'pong' }))
          return
        }
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

    /** frame 事件：传递原始 JPEG ArrayBuffer（由 Canvas 渲染器消费） */
    if (event === 'frame' && buf.length > 4 + headerLen) {
      const jpegBytes = buf.slice(4 + headerLen)
      payload.jpegData = jpegBytes.buffer as ArrayBuffer
    }

    this.dispatch(event, payload)
  }

  /**
   * 订阅指定摄像头的帧推送
   * 连接后自动发送 subscribe 消息给后端，仅接收订阅的摄像头帧
   */
  subscribe(cameraIds: string[]): void {
    this.subscribedCameras = new Set(cameraIds)
    this.sendSubscribe()
  }

  /** 发送订阅消息到后端 */
  private sendSubscribe(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    if (this.subscribedCameras.size === 0) return
    this.ws.send(JSON.stringify({ type: 'subscribe', cameraIds: [...this.subscribedCameras] }))
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
    this.reconnectAttempts++
    /** 指数退避：1s, 2s, 4s, 8s, 16s, 30s, 30s... */
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), EventClient.MAX_BACKOFF * 1000)
    console.log(`[EventClient] 断开，${(delay / 1000).toFixed(0)} 秒后重连 (第 ${this.reconnectAttempts} 次)`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }
}
