import type { Detection } from './events'

/**
 * WS 检测结果缓存（非响应式）
 * detect 事件到达时存入，CameraView overlay 通过 poll 消费
 * 避免每帧创建新对象触发 Vue 响应式
 */

/** 每个摄像头的最新检测结果 */
const detections = new Map<string, Detection[]>()

/** 每个摄像头的检测版本号（自增） */
const versions = new Map<string, number>()

/** 每个摄像头的 AI 推理耗时 */
const inferMsMap = new Map<string, number>()

/** 存入检测结果 */
export function putDetections(cameraId: string, dets: Detection[], inferMs?: number): void {
  detections.set(cameraId, dets)
  versions.set(cameraId, (versions.get(cameraId) ?? 0) + 1)
  if (inferMs != null) inferMsMap.set(cameraId, inferMs)
}

/** 读取检测结果（返回 null 表示无新检测） */
export function takeDetections(cameraId: string, lastVersion: number): { detections: Detection[]; version: number } | null {
  const ver = versions.get(cameraId)
  if (ver === undefined || ver === lastVersion) return null
  const dets = detections.get(cameraId)
  if (!dets) return null
  return { detections: dets, version: ver }
}

/** 获取 AI 推理耗时 */
export function getInferMs(cameraId: string): number {
  return inferMsMap.get(cameraId) ?? 0
}

/** 获取当前版本号 */
export function getDetectVersion(cameraId: string): number {
  return versions.get(cameraId) ?? 0
}

/**
 * 区域事件通知缓存
 * 行为事件（进入/离开区域）到达时存入，CameraView overlay 显示浮动通知
 */

export interface ZoneNotification {
  /** 事件类型 */
  type: 'enter' | 'leave' | 'dwell' | 'line-cross'
  /** 目标名称（自定义名或标签） */
  name: string
  /** 区域名称 */
  zoneName: string
  /** 事件时间戳 */
  timestamp: number
  /** 停留时长（ms，仅 dwell） */
  dwellMs?: number
  /** 穿越方向（仅 line-cross） */
  direction?: string
}

/** 通知显示时长（ms） */
const NOTIFICATION_TTL = 3000

/** 每个摄像头的通知队列 */
const zoneNotifications = new Map<string, ZoneNotification[]>()

/** 添加区域通知 */
export function pushZoneNotification(cameraId: string, notification: ZoneNotification): void {
  let queue = zoneNotifications.get(cameraId)
  if (!queue) {
    queue = []
    zoneNotifications.set(cameraId, queue)
  }
  queue.push(notification)
  /** 限制队列长度 */
  if (queue.length > 5) queue.shift()
}

/** 获取并清理过期的区域通知 */
export function takeZoneNotifications(cameraId: string): ZoneNotification[] {
  const queue = zoneNotifications.get(cameraId)
  if (!queue || queue.length === 0) return []
  const now = Date.now()
  /** 过滤掉过期通知 */
  const active = queue.filter(n => now - n.timestamp < NOTIFICATION_TTL)
  zoneNotifications.set(cameraId, active)
  return active
}

/**
 * 外观匹配建议缓存
 * track:match-suggest 事件到达时存入，CameraView overlay 显示建议提示
 */

export interface MatchSuggestion {
  /** 新目标 trackId */
  trackId: number
  /** 目标标签 */
  label: string
  /** 匹配建议列表 */
  matches: Array<{ trackId: number; customName: string; distance: number }>
  /** 事件时间戳 */
  timestamp: number
}

/** 建议显示时长（ms） */
const SUGGESTION_TTL = 10000

/** 每个摄像头的匹配建议队列 */
const matchSuggestions = new Map<string, MatchSuggestion[]>()

/** 添加匹配建议 */
export function pushMatchSuggestion(cameraId: string, suggestion: MatchSuggestion): void {
  let queue = matchSuggestions.get(cameraId)
  if (!queue) {
    queue = []
    matchSuggestions.set(cameraId, queue)
  }
  queue.push(suggestion)
  /** 限制队列长度 */
  if (queue.length > 3) queue.shift()
}

/** 获取并清理过期的匹配建议 */
export function takeMatchSuggestions(cameraId: string): MatchSuggestion[] {
  const queue = matchSuggestions.get(cameraId)
  if (!queue || queue.length === 0) return []
  const now = Date.now()
  const active = queue.filter(s => now - s.timestamp < SUGGESTION_TTL)
  matchSuggestions.set(cameraId, active)
  return active
}

/** 查找指定 trackId 的最佳匹配建议名称（用于命名弹窗一键应用） */
export function getMatchSuggestionForTrack(cameraId: string, trackId: number): string | null {
  const queue = matchSuggestions.get(cameraId)
  if (!queue) return null
  const now = Date.now()
  for (const s of queue) {
    if (s.trackId === trackId && now - s.timestamp < SUGGESTION_TTL && s.matches.length > 0) {
      return s.matches[0]!.customName
    }
  }
  return null
}
