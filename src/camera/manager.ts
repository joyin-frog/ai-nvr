import { type AppConfig } from "@/config";
import { type EventBus } from "@/event-bus";
import { FrameExtractor } from "./stream";

/**
 * 摄像头管理器
 * 为每个启用的摄像头创建并管理帧提取器实例
 */
export class CameraManager {
  /** 摄像头 ID → 帧提取器 */
  private extractors = new Map<string, FrameExtractor>();

  constructor(
    private config: AppConfig,
    private eventBus: EventBus,
  ) {}

  /** 启动所有摄像头 */
  start(): void {
    for (const cam of this.config.cameras) {
      const extractor = new FrameExtractor(cam, this.config.ffmpegPath, this.eventBus);
      this.extractors.set(cam.id, extractor);
      extractor.start();
      console.log(`[CameraManager] 启动摄像头: ${cam.friendlyName} (${cam.id})`);
    }
  }

  /** 停止所有摄像头 */
  stop(): void {
    for (const [id, extractor] of this.extractors) {
      extractor.stop();
      console.log(`[CameraManager] 停止摄像头: ${id}`);
    }
    this.extractors.clear();
  }

  /** 获取所有摄像头状态 */
  getStatus(): Array<{ id: string; name: string; online: boolean; lastFrameAt: number }> {
    const result: Array<{ id: string; name: string; online: boolean; lastFrameAt: number }> = [];
    for (const cam of this.config.cameras) {
      const extractor = this.extractors.get(cam.id);
      result.push({
        id: cam.id,
        name: cam.friendlyName,
        online: extractor?.isOnline ?? false,
        lastFrameAt: extractor?.lastFrameAt ?? 0,
      });
    }
    return result;
  }
}
