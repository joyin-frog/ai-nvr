import { type AppConfig, type CameraConfig } from "@/config";
import { type EventBus } from "@/event-bus";
import { type MotionRecorder } from "@/storage/recorder";
import { FrameExtractor } from "./stream";

/**
 * 摄像头管理器
 * 为每个启用的摄像头创建并管理帧提取器实例
 * 支持动态增删摄像头（配置热重载）
 */
export class CameraManager {
  /** 摄像头 ID → 帧提取器 */
  private extractors = new Map<string, FrameExtractor>();
  /** 摄像头 ID → 最新一帧（ffmpeg 已缩放） */
  private latestFrames = new Map<string, Buffer>();
  /** 当前摄像头配置列表 */
  private cameraConfigs: CameraConfig[] = [];

  constructor(
    private config: AppConfig,
    private eventBus: EventBus,
    private recorder: MotionRecorder,
  ) {}

  /** 启动所有摄像头 */
  start(): void {
    this.cameraConfigs = this.config.cameras;
    this.eventBus.on("frame", ({ cameraId, data }) => {
      this.latestFrames.set(cameraId, data);
    });

    for (const cam of this.cameraConfigs) {
      this.startCamera(cam);
    }
  }

  /** 停止所有摄像头 */
  stop(): void {
    for (const [id, extractor] of this.extractors) {
      extractor.stop();
      this.recorder.unregisterStream(id);
      console.log(`[CameraManager] 停止摄像头: ${id}`);
    }
    this.extractors.clear();
  }

  /** 获取最新一帧 */
  getLatestFrame(cameraId: string): Buffer | undefined {
    return this.latestFrames.get(cameraId);
  }

  /** 获取所有摄像头状态 */
  getStatus(): Array<{ id: string; name: string; online: boolean; lastFrameAt: number; group: string; ptz: boolean; width: number; height: number }> {
    const result: Array<{ id: string; name: string; online: boolean; lastFrameAt: number; group: string; ptz: boolean; width: number; height: number }> = [];
    for (const cam of this.cameraConfigs) {
      const extractor = this.extractors.get(cam.id);
      result.push({
        id: cam.id,
        name: cam.friendlyName,
        online: extractor?.isOnline ?? false,
        lastFrameAt: extractor?.lastFrameAt ?? 0,
        group: cam.group,
        ptz: cam.ptz?.enabled === true,
        width: cam.detectWidth,
        height: cam.detectHeight,
      });
    }
    return result;
  }

  /** 热重载配置：对比新旧摄像头列表，增删改 */
  reloadConfig(newConfig: AppConfig): void {
    const oldMap = new Map(this.cameraConfigs.map(c => [c.id, c]));
    const newMap = new Map(newConfig.cameras.map(c => [c.id, c]));

    /** 停止已移除的摄像头 */
    for (const id of oldMap.keys()) {
      if (!newMap.has(id)) {
        const extractor = this.extractors.get(id);
        if (extractor) {
          extractor.stop();
          this.extractors.delete(id);
          this.latestFrames.delete(id);
          this.recorder.unregisterStream(id);
          console.log(`[CameraManager] 移除摄像头: ${id}`);
        }
      }
    }

    /** 检测配置变更的摄像头（RTSP URL、FPS、分辨率等） */
    for (const [id, newCam] of newMap) {
      const oldCam = oldMap.get(id);
      if (!oldCam) continue;
      if (this.configChanged(oldCam, newCam)) {
        console.log(`[CameraManager] 配置变更，重启摄像头: ${id}`);
        const extractor = this.extractors.get(id);
        if (extractor) {
          extractor.stop();
          this.extractors.delete(id);
        }
        this.recorder.unregisterStream(id);
        this.startCamera(newCam);
      } else {
        /** 仅更新名称等不影响 ffmpeg 的配置 */
        this.recorder.registerCameraName(id, newCam.friendlyName);
      }
    }

    /** 启动新增的摄像头 */
    for (const cam of newConfig.cameras) {
      if (!oldMap.has(cam.id)) {
        this.startCamera(cam);
        console.log(`[CameraManager] 新增摄像头: ${cam.friendlyName} (${cam.id})`);
      }
    }

    this.cameraConfigs = newConfig.cameras;
    this.config = newConfig;
  }

  /** 判断摄像头配置是否需要重启 ffmpeg */
  private configChanged(old: CameraConfig, cur: CameraConfig): boolean {
    return old.stream.sd !== cur.stream.sd
      || old.stream.hd !== cur.stream.hd
      || old.detectFps !== cur.detectFps
      || old.detectWidth !== cur.detectWidth
      || old.detectHeight !== cur.detectHeight
      || old.jpegQuality !== cur.jpegQuality;
  }

  /** 启动单个摄像头 */
  private startCamera(cam: CameraConfig): void {
    /** 子码流用于预览/检测 */
    const extractor = new FrameExtractor(cam, this.config.ffmpegPath, this.eventBus);
    this.extractors.set(cam.id, extractor);
    extractor.start();

    /** 主码流注册给录像器 */
    this.recorder.registerStream(cam.id, cam.stream.hd);
    /** 注册摄像头名称（用于录像水印） */
    this.recorder.registerCameraName(cam.id, cam.friendlyName);

    console.log(`[CameraManager] 启动摄像头: ${cam.friendlyName} (${cam.id})`);
  }
}
