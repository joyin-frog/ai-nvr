import { type RuntimeConfig } from "@/runtime-config";
import { type EventStorage } from "@/storage/events";
import { type AlertStorage } from "@/alert/storage";
import { type SnapshotStorage } from "@/storage/snapshots";
import { type ThumbnailGenerator } from "@/storage/thumbnails";

/**
 * 统一存储清理管理器
 * 定期清理各存储模块的过期数据，保留天数由 RuntimeConfig 控制
 */
export class StorageCleaner {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private runtimeConfig: RuntimeConfig,
    private eventStorage: EventStorage,
    private alertStorage: AlertStorage,
    private snapshotStorage: SnapshotStorage,
    private thumbnailGenerator: ThumbnailGenerator,
  ) {}

  /** 启动定时清理（每小时执行一次） */
  start(): void {
    /** 首次延迟 5 分钟执行，避免启动时 IO 压力 */
    setTimeout(() => this.runCleanup(), 300_000);
    this.timer = setInterval(() => this.runCleanup(), 3600_000);
    console.log("[Cleaner] 存储清理管理器已启动");
  }

  /** 停止定时清理 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 执行一次全量清理 */
  runCleanup(): CleanupReport {
    const cleanup = this.runtimeConfig.get().cleanup;
    const now = Date.now();
    const report: CleanupReport = { events: 0, alerts: 0, snapshots: 0, thumbnails: 0 };

    /** 清理事件历史 */
    const eventsCutoff = now - cleanup.eventsRetentionDays * 86_400_000;
    report.events = this.eventStorage.purge(eventsCutoff);

    /** 清理告警记录 */
    const alertsCutoff = now - cleanup.alertsRetentionDays * 86_400_000;
    report.alerts = this.alertStorage.purge(alertsCutoff);

    /** 清理检测快照 */
    report.snapshots = this.snapshotStorage.purge(cleanup.snapshotsRetentionDays);

    /** 清理缩略图缓存 */
    this.thumbnailGenerator.purge(cleanup.thumbnailsRetentionDays);

    if (report.events + report.alerts + report.snapshots > 0) {
      console.log(`[Cleaner] 清理完成: ${report.events} 事件, ${report.alerts} 告警, ${report.snapshots} 快照`);
    }

    return report;
  }

  /** 获取各存储的使用统计 */
  getStats(): StorageStats {
    const cleanup = this.runtimeConfig.get().cleanup;
    return {
      events: { retentionDays: cleanup.eventsRetentionDays },
      alerts: { retentionDays: cleanup.alertsRetentionDays },
      snapshots: { retentionDays: cleanup.snapshotsRetentionDays },
      thumbnails: { retentionDays: cleanup.thumbnailsRetentionDays },
      recordings: { retentionDays: this.runtimeConfig.get().recording.retentionDays },
    };
  }
}

/** 清理报告 */
interface CleanupReport {
  events: number;
  alerts: number;
  snapshots: number;
  thumbnails: number;
}

/** 存储统计 */
export interface StorageStats {
  events: { retentionDays: number };
  alerts: { retentionDays: number };
  snapshots: { retentionDays: number };
  thumbnails: { retentionDays: number };
  recordings: { retentionDays: number };
}
