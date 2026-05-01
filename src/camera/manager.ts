import { type AppConfig, type CameraConfig } from "@/config";
import { type EventBus } from "@/event-bus";
import { type MotionRecorder } from "@/storage/recorder";
import { FrameExtractor } from "./stream";

/**
 * 摄像头管理器
 * 为每个启用的摄像头创建并管理帧提取器实例
 *
 * 双流模式：当 HD 和 SD 码流都配置时
 *   - HD 流（display）：高帧率、原始分辨率 → 用于前端显示和录像
 *   - SD 流（detect）：低帧率、可缩放 → 用于 AI 检测和变动检测
 * 单流模式：只有一个码流时，显示和检测共用同一流
 */
export class CameraManager {
  /** 摄像头 ID → 显示流提取器 */
  private displayExtractors = new Map<string, FrameExtractor>();
  /** 摄像头 ID → 检测流提取器（双流模式专用） */
  private detectExtractors = new Map<string, FrameExtractor>();
  /** 摄像头 ID → 是否使用双流模式 */
  private dualStreamFlags = new Map<string, boolean>();
  /** 摄像头 ID → 最新一帧（显示流，高清） */
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
    /** 显示流的帧用于前端显示和录像 */
    this.eventBus.on("frame", ({ cameraId, data }) => {
      this.latestFrames.set(cameraId, data);
    });

    for (const cam of this.cameraConfigs) {
      this.startCamera(cam);
    }
  }

  /** 停止所有摄像头 */
  stop(): void {
    for (const [id] of this.displayExtractors) {
      this.stopCamera(id);
    }
    this.displayExtractors.clear();
    this.detectExtractors.clear();
    this.dualStreamFlags.clear();
  }

  /** 获取最新一帧（显示流） */
  getLatestFrame(cameraId: string): Buffer | undefined {
    return this.latestFrames.get(cameraId);
  }

  /** 获取所有摄像头状态 */
  getStatus(): Array<{ id: string; name: string; online: boolean; lastFrameAt: number; group: string; ptz: boolean; width: number; height: number; dualStream: boolean }> {
    const result: Array<{ id: string; name: string; online: boolean; lastFrameAt: number; group: string; ptz: boolean; width: number; height: number; dualStream: boolean }> = [];
    for (const cam of this.cameraConfigs) {
      const extractor = this.displayExtractors.get(cam.id);
      const dual = this.dualStreamFlags.get(cam.id) ?? false;
      result.push({
        id: cam.id,
        name: cam.friendlyName,
        online: extractor?.isOnline ?? false,
        lastFrameAt: extractor?.lastFrameAt ?? 0,
        group: cam.group,
        ptz: cam.ptz?.enabled === true,
        width: cam.detectWidth,
        height: cam.detectHeight,
        dualStream: dual,
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
        this.stopCamera(id);
        console.log(`[CameraManager] 移除摄像头: ${id}`);
      }
    }

    /** 检测配置变更的摄像头 */
    for (const [id, newCam] of newMap) {
      const oldCam = oldMap.get(id);
      if (!oldCam) continue;
      if (this.configChanged(oldCam, newCam)) {
        console.log(`[CameraManager] 配置变更，重启摄像头: ${id}`);
        this.stopCamera(id);
        this.startCamera(newCam);
      } else {
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
    const hasDual = !!(cam.stream.hd && cam.stream.sd);

    if (hasDual) {
      /** 双流模式：HD 显示 + SD 检测 */
      this.dualStreamFlags.set(cam.id, true);

      const displayExtractor = new FrameExtractor(
        cam, this.config.ffmpegPath, this.eventBus,
        "display",
        cam.stream.hd,
        0,
        0,
      );
      this.displayExtractors.set(cam.id, displayExtractor);
      displayExtractor.start();

      const detectExtractor = new FrameExtractor(
        cam, this.config.ffmpegPath, this.eventBus,
        "detect",
        cam.stream.sd,
        cam.detectFps,
        cam.detectWidth,
      );
      this.detectExtractors.set(cam.id, detectExtractor);
      detectExtractor.start();

      console.log(`[CameraManager] 双流模式: ${cam.friendlyName} (HD=显示, SD=检测)`);
    } else {
      /** 单流模式：显示和检测共用，行为与之前完全一致 */
      this.dualStreamFlags.set(cam.id, false);

      const extractor = new FrameExtractor(cam, this.config.ffmpegPath, this.eventBus);
      this.displayExtractors.set(cam.id, extractor);
      extractor.start();

      console.log(`[CameraManager] 单流模式: ${cam.friendlyName} (${cam.id})`);
    }

    this.recorder.registerCameraName(cam.id, cam.friendlyName);
  }

  /** 停止单个摄像头的所有流 */
  private stopCamera(id: string): void {
    const display = this.displayExtractors.get(id);
    if (display) {
      display.stop();
      this.displayExtractors.delete(id);
    }
    const detect = this.detectExtractors.get(id);
    if (detect) {
      detect.stop();
      this.detectExtractors.delete(id);
    }
    this.latestFrames.delete(id);
    this.dualStreamFlags.delete(id);
    this.recorder.unregisterStream(id);
  }
}
