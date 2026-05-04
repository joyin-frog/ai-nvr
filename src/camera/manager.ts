import { type AppConfig, type CameraConfig } from "@/config";
import { type EventBus } from "@/event-bus";
import { type RuntimeConfig } from "@/runtime-config";
import { type MotionRecorder } from "@/storage/recorder";
import { H264Fmp4Extractor } from "./h264-fmp4-muxer";
import { Fmp4RingBuffer } from "@/storage/fmp4-ring-buffer";

/**
 * 摄像头管理器
 * 为每个启用的摄像头创建并管理帧提取器实例
 * 是 camera:online / camera:offline 事件的唯一权威源
 *
 * 架构（单连接）：
 *   HD 流 → H264Fmp4Extractor → fMP4 (前端 MSE 播放 + 录像环形缓冲)
 *                             → 内置 JPEG 解码 → 检测 + MJPEG 回退
 */
export class CameraManager {
  /** 摄像头 ID → fMP4 流提取器（高分辨率 H.264，用于实时播放和录像 + 内置 JPEG 抽帧） */
  private fmp4Extractors = new Map<string, H264Fmp4Extractor>();
  /** 摄像头 ID → fMP4 环形缓冲区（用于录像预缓冲） */
  private ringBuffers = new Map<string, Fmp4RingBuffer>();
  /** 摄像头 ID → 最新一帧（JPEG，带时间戳） */
  private latestFrames = new Map<string, { data: Buffer; timestamp: number }>();
  /** 当前摄像头配置列表 */
  private cameraConfigs: CameraConfig[] = [];
  /** 摄像头 ID → 配置 Map（O(1) 查找） */
  private cameraConfigMap = new Map<string, CameraConfig>();
  /** 摄像头在线状态（去重用） */
  private cameraOnlineState = new Map<string, boolean>();
  /** 取消订阅 extractor 内部事件的函数 */
  private unsubExtractors: (() => void)[] = [];
  /** 启动时的错开定时器（reloadConfig 时需清除防止重复启动） */
  private staggerTimers: ReturnType<typeof setTimeout>[] = [];

  constructor(
    private config: AppConfig,
    private eventBus: EventBus,
    private recorder: MotionRecorder,
    private runtimeConfig: RuntimeConfig,
  ) {}

  /** 获取摄像头配置（O(1) Map 查找） */
  getCameraConfig(cameraId: string): CameraConfig | undefined {
    return this.cameraConfigMap.get(cameraId);
  }

  /** 从 cameraConfigs 数组重建 Map */
  private rebuildConfigMap(): void {
    this.cameraConfigMap.clear();
    for (const c of this.cameraConfigs) {
      this.cameraConfigMap.set(c.id, c);
    }
  }

  /** 获取 ffmpeg 路径 */
  getFfmpegPath(): string {
    return this.config.ffmpegPath;
  }

  /** 启动所有摄像头 */
  start(): void {
    this.cameraConfigs = this.config.cameras;
    this.rebuildConfigMap();
    /** JPEG 帧用于前端 MJPEG 回退和 latestFrames 缓存 */
    this.unsubExtractors.push(
      this.eventBus.on("frame", ({ cameraId, data, timestamp }) => {
        let entry = this.latestFrames.get(cameraId);
        if (!entry) {
          entry = { data: Buffer.alloc(0), timestamp: 0 };
          this.latestFrames.set(cameraId, entry);
        }
        entry.data = data;
        entry.timestamp = timestamp;
      }),
    );

    /** 监听 extractor 内部事件，去重后发射 camera:online / camera:offline */
    this.unsubExtractors.push(
      this.eventBus.on("extractor:online", ({ cameraId }) => {
        const prev = this.cameraOnlineState.get(cameraId) ?? false;
        if (!prev) {
          this.cameraOnlineState.set(cameraId, true);
          this.eventBus.emit("camera:online", { cameraId });
          console.log(`[CameraManager] ${cameraId} 上线`);
        }
      }),
    );
    this.unsubExtractors.push(
      this.eventBus.on("extractor:offline", ({ cameraId }) => {
        const prev = this.cameraOnlineState.get(cameraId) ?? false;
        if (!prev) return;
        /** fMP4 extractor 是唯一的 extractor，offline 即离线 */
        this.cameraOnlineState.set(cameraId, false);
        this.eventBus.emit("camera:offline", { cameraId });
        console.log(`[CameraManager] ${cameraId} 离线`);
      }),
    );

    /** 错开启动 */
    const staggerMs = this.cameraConfigs.length > 8 ? 500 : 200;
    for (let i = 0; i < this.cameraConfigs.length; i++) {
      const cam = this.cameraConfigs[i]!;
      if (i === 0) {
        this.startCamera(cam);
      } else {
        this.staggerTimers.push(setTimeout(() => this.startCamera(cam), i * staggerMs));
      }
    }
  }

  /** 停止所有摄像头 */
  stop(): void {
    for (const id of [...this.fmp4Extractors.keys()]) {
      this.stopCamera(id);
    }
    this.fmp4Extractors.clear();
    this.ringBuffers.clear();
    this.latestFrames.clear();
    this.cameraOnlineState.clear();
    for (const unsub of this.unsubExtractors) {
      unsub();
    }
    this.unsubExtractors = [];
  }

  /** 获取最新一帧数据（JPEG） */
  getLatestFrame(cameraId: string): Buffer | undefined {
    return this.latestFrames.get(cameraId)?.data;
  }

  /** 获取最新一帧带时间戳（JPEG） */
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
      const fmp4 = this.fmp4Extractors.get(cam.id);
      result.push({
        id: cam.id,
        name: cam.friendlyName,
        online: fmp4?.isOnline ?? false,
        lastFrameAt: fmp4?.lastFrameAt ?? 0,
        group: cam.group,
        ptz: cam.ptz?.enabled === true,
        width: cam.detectWidth,
        height: cam.detectHeight,
        dualStream: false,
        displayFps: Math.round(fmp4?.fps ?? 0),
        detectFps: Math.round(fmp4?.detectFps ?? 0),
        streamFps: Math.round(fmp4?.fps ?? 0),
        streamCodec: fmp4?.detectedCodec ?? null,
        streamWidth: fmp4?.videoWidth ?? 0,
        streamHeight: fmp4?.videoHeight ?? 0,
      });
    }
    return result;
  }

  /** 热重载配置 */
  reloadConfig(newConfig: AppConfig): void {
    /** 清除启动时的错开定时器，防止与手动启动重复 */
    for (const t of this.staggerTimers) clearTimeout(t);
    this.staggerTimers = [];

    const oldMap = new Map(this.cameraConfigs.map(c => [c.id, c]));
    const newMap = new Map(newConfig.cameras.map(c => [c.id, c]));

    for (const id of oldMap.keys()) {
      if (!newMap.has(id)) {
        this.stopCamera(id);
        console.log(`[CameraManager] 移除摄像头: ${id}`);
      }
    }

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

    for (const cam of newConfig.cameras) {
      if (!oldMap.has(cam.id)) {
        this.startCamera(cam);
        console.log(`[CameraManager] 新增摄像头: ${cam.friendlyName} (${cam.id})`);
      }
    }

    this.cameraConfigs = newConfig.cameras;
    this.rebuildConfigMap();
    this.config = newConfig;
  }

  /** 判断摄像头配置是否需要重启 */
  private configChanged(old: CameraConfig, cur: CameraConfig): boolean {
    return old.stream.hd !== cur.stream.hd
      || old.detectFps !== cur.detectFps
      || old.detectWidth !== cur.detectWidth
      || old.detectHeight !== cur.detectHeight
      || old.jpegQuality !== cur.jpegQuality;
  }

  /** 启动单个摄像头 */
  private startCamera(cam: CameraConfig): void {
    const rtspUrl = cam.stream.hd || cam.stream.sd;

    /** fMP4 提取器 + 内置 JPEG 解码，一条 RTSP 连接解决所有需求 */
    const fmp4Extractor = new H264Fmp4Extractor(
      cam, this.config.ffmpegPath, this.eventBus,
      rtspUrl, this.runtimeConfig,
    );
    this.fmp4Extractors.set(cam.id, fmp4Extractor);
    fmp4Extractor.start();

    /** 为录像器创建 fMP4 环形缓冲区
     *  按 2MB/s 估算（覆盖 4K CRF18 场景），确保预缓冲能容纳完整的 bufferDurationMs 时长 */
    const config = this.runtimeConfig.get().recording;
    const maxBytes = Math.ceil(config.bufferDurationMs / 1000) * 2 * 1024 * 1024;
    const ringBuf = new Fmp4RingBuffer(maxBytes);
    this.ringBuffers.set(cam.id, ringBuf);
    this.recorder.setRingBuffer(cam.id, ringBuf);

    this.recorder.registerCameraName(cam.id, cam.friendlyName);

    console.log(`[CameraManager] 启动: ${cam.friendlyName} (${cam.id}) 单连接 fMP4 + JPEG`);
  }

  /** 停止单个摄像头 */
  private stopCamera(id: string): void {
    const fmp4 = this.fmp4Extractors.get(id);
    if (fmp4) {
      fmp4.stop();
      this.fmp4Extractors.delete(id);
    }
    this.ringBuffers.delete(id);
    this.latestFrames.delete(id);
    this.recorder.removeRingBuffer(id);
    this.recorder.unregisterStream(id);
    const wasOnline = this.cameraOnlineState.get(id) ?? false;
    this.cameraOnlineState.delete(id);
    if (wasOnline) {
      this.eventBus.emit("camera:offline", { cameraId: id });
    }
  }
}
