import { type EventBus } from "@/event-bus";

/** 单个摄像头的运行指标 */
export interface CameraMetrics {
  /** 摄像头 ID */
  cameraId: string;
  /** 是否在线 */
  online: boolean;
  /** 显示帧率（frame 事件） */
  fps: number;
  /** 检测帧率（detect:frame 事件） */
  detectFps: number;
  /** 最后帧时间 */
  lastFrameAt: number;
  /** 变动检测总次数 */
  motionCount: number;
  /** AI 检测总次数 */
  detectCount: number;
  /** 平均变动比例 */
  avgMotionRatio: number;
  /** 平均帧大小（KB） */
  avgFrameSizeKb: number;
  /** AI 推理平均延迟（ms） */
  avgInferMs: number;
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
  /** 服务器当前时间（ms） */
  serverTime: number;
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
  /** 检测帧率计数器（detect:frame 事件） */
  private detectFpsCounters = new Map<string, FpsCounter>();
  private motionCounts = new Map<string, number>();
  private motionRatios = new Map<string, { sum: number; count: number }>();
  private detectCounts = new Map<string, number>();
  private cameraOnline = new Map<string, boolean>();
  private cameraLastFrame = new Map<string, number>();
  /** 每路摄像头的帧大小统计（滑动平均） */
  private frameSizeStats = new Map<string, { sum: number; count: number }>();
  /** AI 推理延迟统计（滑动平均 ms） */
  private inferMsStats = new Map<string, { avg: number; count: number }>();
  /** FPS 统计窗口（秒） */
  private fpsWindow = 5;
  /** 低帧率检测：每个摄像头连续低 FPS 的检查周期数 */
  private lowFpsStreaks = new Map<string, number>();
  /** 低帧率阈值（FPS） */
  private static readonly LOW_FPS_THRESHOLD = 3;
  /** 连续低帧率检查次数达到此值时触发事件 */
  private static readonly LOW_FPS_TRIGGER_COUNT = 3;
  /** 低帧率检查间隔（秒） */
  private static readonly LOW_FPS_CHECK_INTERVAL = 10;
  /** 低帧率检查定时器 */
  private lowFpsTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private eventBus: EventBus,
  ) {
    void this.lowFpsTimer;
    /** 帧事件 → 更新 FPS 和在线状态 */
    eventBus.on("frame", ({ cameraId, timestamp, data }) => {
      this.cameraOnline.set(cameraId, true);
      this.cameraLastFrame.set(cameraId, timestamp);

      /** 记录帧大小（指数移动平均，最近约 60 帧权重） */
      let sizeStats = this.frameSizeStats.get(cameraId);
      if (!sizeStats) {
        sizeStats = { sum: data.length / 1024, count: 1 };
        this.frameSizeStats.set(cameraId, sizeStats);
      } else {
        const alpha = 1 / 60;
        sizeStats.sum = sizeStats.sum * (1 - alpha) + (data.length / 1024) * alpha;
        sizeStats.count++;
      }

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

    /** 检测帧事件 → 更新检测帧率 */
    eventBus.on("detect:frame", ({ cameraId, timestamp }) => {
      let counter = this.detectFpsCounters.get(cameraId);
      if (!counter) {
        counter = { frames: 0, windowStart: timestamp, fps: 0 };
        this.detectFpsCounters.set(cameraId, counter);
      }
      counter.frames++;
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

    /** 检测事件 → 计数 + 推理延迟 */
    eventBus.on("detect", ({ cameraId, inferMs }) => {
      this.detectCounts.set(cameraId, (this.detectCounts.get(cameraId) ?? 0) + 1);
      if (inferMs != null) {
        let stats = this.inferMsStats.get(cameraId);
        if (!stats) {
          stats = { avg: inferMs, count: 1 };
          this.inferMsStats.set(cameraId, stats);
        } else {
          /** 指数移动平均 */
          stats.avg = stats.avg * 0.9 + inferMs * 0.1;
          stats.count++;
        }
      }
    });

    /** 在线/离线事件 */
    eventBus.on("camera:online", ({ cameraId }) => {
      this.cameraOnline.set(cameraId, true);
    });
    eventBus.on("camera:offline", ({ cameraId }) => {
      this.cameraOnline.set(cameraId, false);
      this.lowFpsStreaks.delete(cameraId);
    });

    /** 低帧率检查定时器 */
    this.lowFpsTimer = setInterval(() => this.checkLowFps(), SystemMonitor.LOW_FPS_CHECK_INTERVAL * 1000);
  }

  /** 检查所有在线摄像头的帧率，连续低帧率时发出事件 */
  private checkLowFps(): void {
    for (const [cameraId, online] of this.cameraOnline) {
      if (!online) {
        this.lowFpsStreaks.delete(cameraId);
        continue;
      }
      const counter = this.fpsCounters.get(cameraId);
      /** 没有帧计数器或窗口内无数据则跳过 */
      if (!counter || counter.frames === 0) continue;

      const streak = this.lowFpsStreaks.get(cameraId) ?? 0;
      if (counter.fps < SystemMonitor.LOW_FPS_THRESHOLD) {
        this.lowFpsStreaks.set(cameraId, streak + 1);
        if (streak + 1 >= SystemMonitor.LOW_FPS_TRIGGER_COUNT) {
          this.eventBus.emit("camera:lowfps", { cameraId, fps: counter.fps });
          /** 触发后重置，避免重复 */
          this.lowFpsStreaks.set(cameraId, 0);
        }
      } else {
        this.lowFpsStreaks.set(cameraId, 0);
      }
    }
  }

  /** 获取系统指标 */
  getMetrics(cameraIds: string[]): SystemMetrics {
    const mem = process.memoryUsage();
    const cameras: CameraMetrics[] = cameraIds.map(id => {
      const motionStats = this.motionRatios.get(id);
      const sizeStats = this.frameSizeStats.get(id);
      return {
        cameraId: id,
        online: this.cameraOnline.get(id) ?? false,
        fps: this.fpsCounters.get(id)?.fps ?? 0,
        detectFps: this.detectFpsCounters.get(id)?.fps ?? 0,
        lastFrameAt: this.cameraLastFrame.get(id) ?? 0,
        motionCount: this.motionCounts.get(id) ?? 0,
        detectCount: this.detectCounts.get(id) ?? 0,
        avgMotionRatio: motionStats ? motionStats.sum / motionStats.count : 0,
        avgFrameSizeKb: sizeStats ? Math.round(sizeStats.sum / sizeStats.count * 10) / 10 : 0,
        avgInferMs: Math.round(this.inferMsStats.get(id)?.avg ?? 0),
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
      serverTime: Date.now(),
    };
  }
}
