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
