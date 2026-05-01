/**
 * WS 帧数据缓存（非响应式）
 * WS frame 事件到达时存入，CameraView 通过 poll 消费
 * 避免 Vue reactive 追踪 ArrayBuffer 的开销
 */

/** 每个摄像头的最新帧数据 */
const frames = new Map<string, ArrayBuffer>()

/** 每个摄像头的帧版本号（自增） */
const versions = new Map<string, number>()

/** 存入一帧 */
export function putFrame(cameraId: string, jpeg: ArrayBuffer): void {
  frames.set(cameraId, jpeg)
  versions.set(cameraId, (versions.get(cameraId) ?? 0) + 1)
}

/** 读取并消费一帧（返回 null 表示无新帧） */
export function takeFrame(cameraId: string, lastVersion: number): { jpeg: ArrayBuffer; version: number } | null {
  const ver = versions.get(cameraId)
  if (ver === undefined || ver === lastVersion) return null
  const jpeg = frames.get(cameraId)
  if (!jpeg) return null
  return { jpeg, version: ver }
}

/** 获取当前版本号 */
export function getVersion(cameraId: string): number {
  return versions.get(cameraId) ?? 0
}
