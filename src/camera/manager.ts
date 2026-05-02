import { type AppConfig, type CameraConfig } from "@/config";
import { type EventBus } from "@/event-bus";
import { type RuntimeConfig } from "@/runtime-config";
import { type MotionRecorder } from "@/storage/recorder";
import { FrameExtractor } from "./stream";
import { H264Fmp4Extractor } from "./h264-fmp4-muxer";

/**
 * 摄像头管理器
 * 为每个启用的摄像头创建并管理帧提取器实例
 *
 * 架构（优化 RTSP 连接数）：
 *   HD 流：H264Fmp4Extractor（零转码 copy → fMP4）→ 前端 MSE GPU 解码显示
 *   SD 流：FrameExtractor（decode → MJPEG）→ AI 检测 + 录像 + Canvas 备用显示
 *
 * 单流模式：只有一个码流时，FrameExtractor 同时用于显示和检测
 */
export class CameraManager {
  /** 摄像头 ID → 显示流提取器（MJPEG，用于 Canvas 备用显示 + 录像） */
  private displayExtractors = new Map<string, FrameExtractor>();
  /** 摄像头 ID → 检测流提取器（双流模式专用，SD 码流） */
  private detectExtractors = new Map<string, FrameExtractor>();
  /** 摄像头 ID → fMP4 流提取器（高分辨率零转码） */
  private fmp4Extractors = new Map<string, H264Fmp4Extractor>();
  /** 摄像头 ID → 是否使用双流模式 */
  private dualStreamFlags = new Map<string, boolean>();
  /** 摄像头 ID → 最新一帧（显示流，带时间戳） */
  private latestFrames = new Map<string, { data: Buffer; timestamp: number }>();
  /** 当前摄像头配置列表 */
  private cameraConfigs: CameraConfig[] = [];

  constructor(
    private config: AppConfig,
    private eventBus: EventBus,
    private recorder: MotionRecorder,
    private runtimeConfig: RuntimeConfig,
  ) {}

  /** 启动所有摄像头 */
  start(): void {
    this.cameraConfigs = this.config.cameras;
    /** 显示流的帧用于前端显示和录像 */
    this.eventBus.on("frame", ({ cameraId, data, timestamp }) => {
      this.latestFrames.set(cameraId, { data, timestamp });
    });

    for (const cam of this.cameraConfigs) {
      this.startCamera(cam);
    }
  }

  /** 停止所有摄像头 */
  stop(): void {
    for (const id of [...this.displayExtractors.keys()]) {
      this.stopCamera(id);
    }
    this.displayExtractors.clear();
    this.detectExtractors.clear();
    this.fmp4Extractors.clear();
    this.dualStreamFlags.clear();
    this.latestFrames.clear();
  }

  /** 获取最新一帧数据（显示流） */
  getLatestFrame(cameraId: string): Buffer | undefined {
    return this.latestFrames.get(cameraId)?.data;
  }

  /** 获取最新一帧带时间戳（显示流） */
  getLatestFrameWithTimestamp(cameraId: string): { data: Buffer; timestamp: number } | undefined {
    return this.latestFrames.get(cameraId);
  }

  /** 获取 fMP4 提取器 */
  getFmp4Extractor(cameraId: string): H264Fmp4Extractor | undefined {
    return this.fmp4Extractors.get(cameraId);
  }

  /** 获取所有摄像头状态 */
  getStatus(): Array<{ id: string; name: string; online: boolean; lastFrameAt: number; group: string; ptz: boolean; width: number; height: number; dualStream: boolean; displayFps: number; detectFps: number; streamFps: number; streamCodec: string | null; streamWidth: number; streamHeight: number }> {
    const result: Array<{ id: string; name: string; online: boolean; lastFrameAt: number; group: string; ptz: boolean; width: number; height: number; dualStream: boolean; displayFps: number; detectFps: number; streamFps: number; streamCodec: string | null; streamWidth: number; streamHeight: number }> = [];
    for (const cam of this.cameraConfigs) {
      const display = this.displayExtractors.get(cam.id);
      const detect = this.detectExtractors.get(cam.id);
      const fmp4 = this.fmp4Extractors.get(cam.id);
      const dual = this.dualStreamFlags.get(cam.id) ?? false;
      result.push({
        id: cam.id,
        name: cam.friendlyName,
        online: display?.isOnline || fmp4?.isOnline || false,
        lastFrameAt: display?.lastFrameAt ?? 0,
        group: cam.group,
        ptz: cam.ptz?.enabled === true,
        width: cam.detectWidth,
        height: cam.detectHeight,
        dualStream: dual,
        displayFps: Math.round(display?.fps ?? 0),
        detectFps: Math.round(detect?.fps ?? 0),
        streamFps: Math.round(fmp4?.fps ?? 0),
        streamCodec: fmp4?.detectedCodec ?? null,
        streamWidth: fmp4?.videoWidth ?? 0,
        streamHeight: fmp4?.videoHeight ?? 0,
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
      /**
       * 双流模式（优化版，仅 2 个 RTSP 连接）：
       * HD 流：H264Fmp4Extractor（零转码 copy → fMP4）→ 前端 MSE GPU 解码
       * SD 流：FrameExtractor（decode → MJPEG）→ AI 检测 + 录像 + Canvas 备用显示
       *   （display 模式同时发 frame 和 detect:frame 事件）
       */
      this.dualStreamFlags.set(cam.id, true);

      /** SD 流：同时用于检测 + 录像 + Canvas 备用显示 */
      const displayExtractor = new FrameExtractor(
        cam, this.config.ffmpegPath, this.eventBus,
        "display",
        cam.stream.sd,
        0,
        0,
      );
      this.displayExtractors.set(cam.id, displayExtractor);
      displayExtractor.start();

      /** HD 流：零转码 H.264 → fMP4（前端 MSE 解码，CPU 开销极低） */
      const fmp4Extractor = new H264Fmp4Extractor(
        cam, this.config.ffmpegPath, this.eventBus,
        cam.stream.hd!, this.runtimeConfig,
      );
      this.fmp4Extractors.set(cam.id, fmp4Extractor);
      fmp4Extractor.start();

      console.log(`[CameraManager] 双流模式(2连接): ${cam.friendlyName} (HD=H264→fMP4, SD=检测+录像)`);
    } else {
      /** 单流模式：显示和检测共用，行为与之前完全一致 */
      this.dualStreamFlags.set(cam.id, false);

      const extractor = new FrameExtractor(cam, this.config.ffmpegPath, this.eventBus);
      this.displayExtractors.set(cam.id, extractor);
      extractor.start();

      /** 单流时也启动 fMP4 流（如果只有一个码流） */
      const url = cam.stream.hd || cam.stream.sd;
      if (url) {
        const fmp4Extractor = new H264Fmp4Extractor(
          cam, this.config.ffmpegPath, this.eventBus,
          url, this.runtimeConfig,
        );
        this.fmp4Extractors.set(cam.id, fmp4Extractor);
        fmp4Extractor.start();
      }

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
    const fmp4 = this.fmp4Extractors.get(id);
    if (fmp4) {
      fmp4.stop();
      this.fmp4Extractors.delete(id);
    }
    this.latestFrames.delete(id);
    this.dualStreamFlags.delete(id);
    this.recorder.unregisterStream(id);
  }
}
