import { type RuntimeConfig } from "@/runtime-config";
import { type EventStorage } from "@/storage/events";
import { type ObserverStorage } from "@/observer/storage";
import { type AlertStorage } from "@/alert/storage";
import { type SignalStore } from "@/signal/store";
import { type SnapshotStorage } from "@/storage/snapshots";
import { type ThumbnailGenerator } from "@/storage/thumbnails";
import { type RecordingExporter } from "@/storage/export";
import { type TrackStorage } from "@/storage/tracks";
import { type TrackTrajectoryStorage } from "@/storage/track-trajectory";
import { type DiskUsage } from "@/storage/disk-usage";
import { type MotionRecorder } from "@/storage/recorder";
import { type TrackLabelStorage } from "@/storage/track-labels";

/** 磁盘压力等级 */
type DiskPressure = "normal" | "warning" | "critical";

/**
 * 统一存储清理管理器
 * 定期清理各存储模块的过期数据，保留天数由 RuntimeConfig 控制
 * 磁盘空间紧张时自动缩短保留天数以释放空间
 */
export class StorageCleaner {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 防止清理重叠执行的锁 */
  private running = false;

  constructor(
    private runtimeConfig: RuntimeConfig,
    private eventStorage: EventStorage,
    private observerStorage: ObserverStorage,
    private thumbnailGenerator: ThumbnailGenerator,
    private exporter: RecordingExporter,
    private diskUsage: DiskUsage,
    private recorder: MotionRecorder,
    private trackStorage?: TrackStorage,
    private alertSnapshotStorage?: SnapshotStorage,
    private trajectoryStorage?: TrackTrajectoryStorage,
    private trackLabelStorage?: TrackLabelStorage,
    private alertStorage?: AlertStorage,
    private signalStore?: SignalStore,
  ) {}

  private initialTimer: ReturnType<typeof setTimeout> | null = null;

  /** 启动定时清理（每小时执行一次） */
  start(): void {
    /** 首次延迟 5 分钟执行，避免启动时 IO 压力 */
    this.initialTimer = setTimeout(() => { this.initialTimer = null; this.runCleanup(); }, 300_000);
    this.timer = setInterval(() => this.runCleanup(), 3600_000);
    console.log("[Cleaner] 存储清理管理器已启动");
  }

  /** 停止定时清理 */
  stop(): void {
    if (this.initialTimer) { clearTimeout(this.initialTimer); this.initialTimer = null; }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 获取磁盘压力等级 */
  private getDiskPressure(): { pressure: DiskPressure; usedPercent: number } {
    const info = this.diskUsage.getInfo();
    if (info.diskTotalBytes === 0) return { pressure: "normal", usedPercent: 0 };
    const usedPercent = ((info.diskTotalBytes - info.diskFreeBytes) / info.diskTotalBytes) * 100;
    if (usedPercent >= 95) return { pressure: "critical", usedPercent };
    if (usedPercent >= 85) return { pressure: "warning", usedPercent };
    return { pressure: "normal", usedPercent };
  }

  /**
   * 根据磁盘压力计算有效保留天数
   * warning (85-95%): 保留天数线性缩减到配置值的 50%
   * critical (>95%): 保留天数缩减到配置值的 25%
   */
  private effectiveRetention(configuredDays: number, pressure: DiskPressure, usedPercent: number): number {
    if (pressure === "normal" || configuredDays <= 1) return configuredDays;
    if (pressure === "critical") return Math.max(1, Math.floor(configuredDays * 0.25));
    /** warning: 线性插值 85%→100%, 95%→50% */
    const factor = 1 - ((usedPercent - 85) / 10) * 0.5;
    return Math.max(1, Math.floor(configuredDays * factor));
  }

  /** 执行一次全量清理（磁盘感知） */
  async runCleanup(): Promise<CleanupReport> {
    if (this.running) return { events: 0, alerts: 0, snapshots: 0, thumbnails: 0, exports: 0, tracks: 0, trackLabels: 0 };
    this.running = true;
    try {
      return await this.doCleanup();
    } finally {
      this.running = false;
    }
  }

  private async doCleanup(): Promise<CleanupReport> {
    const cleanup = this.runtimeConfig.get().cleanup;
    const { pressure, usedPercent } = this.getDiskPressure();
    const now = Date.now();
    const report: CleanupReport = { events: 0, alerts: 0, snapshots: 0, thumbnails: 0, exports: 0, tracks: 0, trackLabels: 0 };

    /** 磁盘压力日志 */
    if (pressure !== "normal") {
      console.log(`[Cleaner] 磁盘使用 ${usedPercent.toFixed(1)}%，压力等级: ${pressure}，启用加速清理`);
    }

    /** 计算有效保留天数 */
    const eventsDays = this.effectiveRetention(cleanup.eventsRetentionDays, pressure, usedPercent);
    const alertsDays = this.effectiveRetention(cleanup.alertsRetentionDays, pressure, usedPercent);
    const snapshotsDays = this.effectiveRetention(cleanup.snapshotsRetentionDays, pressure, usedPercent);
    const thumbnailsDays = this.effectiveRetention(cleanup.thumbnailsRetentionDays, pressure, usedPercent);

    /** 清理事件历史 */
    const eventsCutoff = now - eventsDays * 86_400_000;
    report.events = this.eventStorage.purge(eventsCutoff);

    /** 清理检测规则记录 */
    const alertsCutoff = now - alertsDays * 86_400_000;
    report.alerts = this.observerStorage.purge(alertsCutoff);

    /** 清理告警记录 */
    if (this.alertStorage) {
      this.alertStorage.purge(alertsCutoff);
    }

    /** 清理信号变更历史（复用告警保留天数） */
    if (this.signalStore) {
      this.signalStore.purge(alertsCutoff);
    }


    /** 清理告警快照（复用快照保留天数配置） */
    if (this.alertSnapshotStorage) {
      report.snapshots = await this.alertSnapshotStorage.purge(snapshotsDays);
    }

    /** 清理缩略图缓存 */
    report.thumbnails = await this.thumbnailGenerator.purge(thumbnailsDays);

    /** 清理导出临时文件（24小时后过期，磁盘紧张时立即清理） */
    report.exports = await this.exporter.purge(pressure === "critical" ? 0 : 24);

    /** 清理过期追踪目标 */
    if (this.trackStorage) {
      report.tracks = this.trackStorage.cleanup(snapshotsDays);
    }

    /** 清理过期轨迹采样数据 */
    if (this.trajectoryStorage) {
      this.trajectoryStorage.cleanup(snapshotsDays);
    }

    /** 清理过期追踪标签 */
    if (this.trackLabelStorage) {
      report.trackLabels = this.trackLabelStorage.purge(snapshotsDays);
    }

    /** 磁盘压力时触发录像加速清理 */
    if (pressure !== "normal") {
      const recordingsDays = this.effectiveRetention(this.runtimeConfig.get().recording.retentionDays, pressure, usedPercent);
      await this.recorder.purgeOldRecordings(recordingsDays);
    }

    const total = report.events + report.alerts + report.snapshots + report.exports + report.tracks + report.trackLabels;
    if (total > 0 || pressure !== "normal") {
      const daysInfo = pressure !== "normal"
        ? ` (保留天数: 事件${eventsDays}d 告警${alertsDays}d 快照${snapshotsDays}d 缩略图${thumbnailsDays}d)`
        : "";
      console.log(`[Cleaner] 清理完成: ${report.events} 事件, ${report.alerts} 告警, ${report.snapshots} 快照, ${report.exports} 导出, ${report.tracks} 追踪目标, ${report.trackLabels} 标签${daysInfo}`);
    }

    return report;
  }

  /** 获取各存储的使用统计（含磁盘压力） */
  getStats(): StorageStats {
    const cleanup = this.runtimeConfig.get().cleanup;
    const { pressure, usedPercent } = this.getDiskPressure();
    return {
      events: { retentionDays: cleanup.eventsRetentionDays },
      alerts: { retentionDays: cleanup.alertsRetentionDays },
      snapshots: { retentionDays: cleanup.snapshotsRetentionDays },
      thumbnails: { retentionDays: cleanup.thumbnailsRetentionDays },
      recordings: { retentionDays: this.runtimeConfig.get().recording.retentionDays },
      diskPressure: pressure,
      diskUsedPercent: Math.round(usedPercent * 10) / 10,
    };
  }
}

/** 清理报告 */
export interface CleanupReport {
  events: number;
  alerts: number;
  snapshots: number;
  thumbnails: number;
  exports: number;
  tracks: number;
  trackLabels: number;
}

/** 存储统计 */
export interface StorageStats {
  events: { retentionDays: number };
  alerts: { retentionDays: number };
  snapshots: { retentionDays: number };
  thumbnails: { retentionDays: number };
  recordings: { retentionDays: number };
  /** 当前磁盘压力等级 */
  diskPressure: DiskPressure;
  /** 磁盘使用百分比 */
  diskUsedPercent: number;
}
