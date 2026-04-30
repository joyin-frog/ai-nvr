import { type EventBus } from "@/event-bus";

/** 单个摄像头的运行指标 */
export interface CameraMetrics {
  /** 摄像头 ID */
  cameraId: string;
  /** 是否在线 */
  online: boolean;
  /** 最近 5 秒帧率 */
  fps: number;
  /** 最后帧时间 */
  lastFrameAt: number;
  /** 变动检测总次数 */
  motionCount: number;
  /** AI 检测总次数 */
  detectCount: number;
  /** 平均变动比例 */
  avgMotionRatio: number;
}

/** 系统整体指标 */
export interface SystemMetrics {
  /** 系统运行时长（秒） */
  uptime: number;
  /** 内存使用（MB） */
  memoryUsedMb: number;
  /** 内存 RSS（MB） */
  memoryRssMb: number;
  /** 摄像头数量 */
  cameraCount: number;
  /** 在线摄像头数量 */
  onlineCameras: number;
  /** 各摄像头指标 */
  cameras: CameraMetrics[];
  /** 系统启动时间 */
  startedAt: number;
}

/** 帧率统计窗口 */
interface FpsCounter {
  /** 窗口内帧数 */
  frames: number;
  /** 窗口开始时间 */
  windowStart: number;
  /** 当前 FPS */
  fps: number;
}

/**
 * 系统性能监控
 * 收集帧率、变动/检测计数、内存使用等指标
 */
export class SystemMonitor {
  private startedAt = Date.now();
  private fpsCounters = new Map<string, FpsCounter>();
  private motionCounts = new Map<string, number>();
  private motionRatios = new Map<string, { sum: number; count: number }>();
  private detectCounts = new Map<string, number>();
  private cameraOnline = new Map<string, boolean>();
  private cameraLastFrame = new Map<string, number>();
  /** FPS 统计窗口（秒） */
  private fpsWindow = 5;

  constructor(eventBus: EventBus) {
    /** 帧事件 → 更新 FPS 和在线状态 */
    eventBus.on("frame", ({ cameraId, timestamp }) => {
      this.cameraOnline.set(cameraId, true);
      this.cameraLastFrame.set(cameraId, timestamp);

      let counter = this.fpsCounters.get(cameraId);
      if (!counter) {
        counter = { frames: 0, windowStart: timestamp, fps: 0 };
        this.fpsCounters.set(cameraId, counter);
      }
      counter.frames++;

      /** 每 fpsWindow 毫秒刷新一次 FPS */
      if (timestamp - counter.windowStart >= this.fpsWindow * 1000) {
        counter.fps = Math.round(counter.frames / ((timestamp - counter.windowStart) / 1000) * 10) / 10;
        counter.frames = 0;
        counter.windowStart = timestamp;
      }
    });

    /** 变动事件 → 计数 + 平均比例 */
    eventBus.on("motion", ({ cameraId, ratio }) => {
      this.motionCounts.set(cameraId, (this.motionCounts.get(cameraId) ?? 0) + 1);
      let stats = this.motionRatios.get(cameraId);
      if (!stats) {
        stats = { sum: 0, count: 0 };
        this.motionRatios.set(cameraId, stats);
      }
      stats.sum += ratio;
      stats.count++;
    });

    /** 检测事件 → 计数 */
    eventBus.on("detect", ({ cameraId }) => {
      this.detectCounts.set(cameraId, (this.detectCounts.get(cameraId) ?? 0) + 1);
    });

    /** 在线/离线事件 */
    eventBus.on("camera:online", ({ cameraId }) => {
      this.cameraOnline.set(cameraId, true);
    });
    eventBus.on("camera:offline", ({ cameraId }) => {
      this.cameraOnline.set(cameraId, false);
    });
  }

  /** 获取系统指标 */
  getMetrics(cameraIds: string[]): SystemMetrics {
    const mem = process.memoryUsage();
    const cameras: CameraMetrics[] = cameraIds.map(id => {
      const motionStats = this.motionRatios.get(id);
      return {
        cameraId: id,
        online: this.cameraOnline.get(id) ?? false,
        fps: this.fpsCounters.get(id)?.fps ?? 0,
        lastFrameAt: this.cameraLastFrame.get(id) ?? 0,
        motionCount: this.motionCounts.get(id) ?? 0,
        detectCount: this.detectCounts.get(id) ?? 0,
        avgMotionRatio: motionStats ? motionStats.sum / motionStats.count : 0,
      };
    });

    return {
      uptime: Math.floor((Date.now() - this.startedAt) / 1000),
      memoryUsedMb: Math.round(mem.heapUsed / 1024 / 1024 * 10) / 10,
      memoryRssMb: Math.round(mem.rss / 1024 / 1024 * 10) / 10,
      cameraCount: cameraIds.length,
      onlineCameras: cameras.filter(c => c.online).length,
      cameras,
      startedAt: this.startedAt,
    };
  }
}
