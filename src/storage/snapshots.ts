import { mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { type EventBus } from "@/event-bus";

/** 快照元信息 */
export interface SnapshotInfo {
  /** 文件名 */
  filename: string;
  /** 摄像头 ID */
  cameraId: string;
  /** 时间戳 */
  timestamp: number;
  /** 文件大小 */
  size: number;
}

/**
 * 检测快照存储器
 * 监听 detect 事件，保存标注图到磁盘
 * 支持按摄像头列出和清理过期快照
 */
export class SnapshotStorage {
  private storagePath: string;
  /** 自动清理天数 */
  private retentionDays: number;

  constructor(storagePath: string, private eventBus: EventBus, retentionDays = 30) {
    this.storagePath = storagePath;
    this.retentionDays = retentionDays;
    mkdirSync(storagePath, { recursive: true });
  }

  /** 启动：监听 detect 事件保存标注图 */
  start(): void {
    this.eventBus.on("detect", ({ cameraId, timestamp, annotatedImage }) => {
      this.saveSnapshot(cameraId, timestamp, annotatedImage);
    });

    /** 每小时清理过期快照 */
    setInterval(() => this.purgeOldSnapshots(), 3600_000);
    console.log("[Snapshot] 快照存储已启动");
  }

  /** 保存快照 */
  saveSnapshot(cameraId: string, timestamp: number, imageData: Buffer): string {
    const dir = join(this.storagePath, cameraId);
    mkdirSync(dir, { recursive: true });

    const date = new Date(timestamp);
    const dateStr = date.toISOString().slice(0, 10);
    const timeStr = date.toISOString().slice(11, 19).replace(/:/g, "-");
    const ms = String(date.getMilliseconds()).padStart(3, "0");
    const filename = `${dateStr}_${timeStr}_${ms}.jpg`;

    const filePath = join(dir, filename);
    writeFileSync(filePath, imageData);

    console.log(`[Snapshot] 已保存: ${cameraId}/${filename} (${imageData.length} bytes)`);
    return `${cameraId}/${filename}`;
  }

  /** 列出快照 */
  listSnapshots(cameraId?: string): SnapshotInfo[] {
    const results: SnapshotInfo[] = [];

    const scanDir = cameraId ? join(this.storagePath, cameraId) : this.storagePath;
    let dirs: string[];

    try {
      if (cameraId) {
        dirs = [scanDir];
      } else {
        dirs = readdirSync(this.storagePath)
          .filter(f => statSync(join(this.storagePath, f)).isDirectory())
          .map(f => join(this.storagePath, f));
      }
    } catch {
      return results;
    }

    for (const dir of dirs) {
      const camId = cameraId ?? dir.split("/").pop()!;
      let files: string[];
      try {
        files = readdirSync(dir);
      } catch {
        continue;
      }

      for (const file of files) {
        if (!file.endsWith(".jpg")) continue;
        const filePath = join(dir, file);
        const stat = statSync(filePath);
        const timestamp = this.parseTimestamp(file);
        results.push({
          filename: `${camId}/${file}`,
          cameraId: camId,
          timestamp,
          size: stat.size,
        });
      }
    }

    return results.sort((a, b) => b.timestamp - a.timestamp);
  }

  /** 获取快照文件路径 */
  getSnapshotPath(relativePath: string): string {
    return join(this.storagePath, relativePath);
  }

  /** 清理过期快照 */
  private purgeOldSnapshots(): void {
    const cutoff = Date.now() - this.retentionDays * 86400_000;

    try {
      const camDirs = readdirSync(this.storagePath);
      for (const camDir of camDirs) {
        const camPath = join(this.storagePath, camDir);
        if (!statSync(camPath).isDirectory()) continue;

        const files = readdirSync(camPath);
        for (const file of files) {
          if (!file.endsWith(".jpg")) continue;
          const filePath = join(camPath, file);
          const stat = statSync(filePath);
          if (stat.mtimeMs < cutoff) {
            unlinkSync(filePath);
          }
        }
      }
    } catch {
      // ignore
    }
  }

  /** 从文件名解析时间戳 */
  private parseTimestamp(filename: string): number {
    const match = filename.match(/^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})/);
    if (!match) return 0;
    const dateStr = `${match[1]}T${match[2]}:${match[3]}:${match[4]}`;
    return new Date(dateStr).getTime();
  }
}
