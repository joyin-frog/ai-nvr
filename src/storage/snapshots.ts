import { mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type EventBus } from "@/event-bus";
import { type Detection } from "@/ai/types";

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
  /** 检测到的目标标签摘要（如 "person, car"） */
  detectionLabels?: string;
}

/**
 * 检测快照存储器
 * 监听 detect 事件，保存标注图到磁盘
 * 支持按摄像头列出和清理过期快照
 */
export class SnapshotStorage {
  private storagePath: string;

  constructor(storagePath: string, private eventBus: EventBus) {
    this.storagePath = storagePath;
    mkdirSync(storagePath, { recursive: true });
  }

  /** 启动：监听 detect 事件保存标注图和元数据 */
  start(): void {
    this.eventBus.on("detect", ({ cameraId, timestamp, annotatedImage, detections }) => {
      this.saveSnapshot(cameraId, timestamp, annotatedImage, detections);
    });
    console.log("[Snapshot] 快照存储已启动");
  }

  /** 保存快照（标注图 + 检测结果 JSON） */
  saveSnapshot(cameraId: string, timestamp: number, imageData: Buffer, detections?: Detection[]): string {
    const dir = join(this.storagePath, cameraId);
    mkdirSync(dir, { recursive: true });

    const date = new Date(timestamp);
    const dateStr = date.toISOString().slice(0, 10);
    const timeStr = date.toISOString().slice(11, 19).replace(/:/g, "-");
    const ms = String(date.getMilliseconds()).padStart(3, "0");
    const filename = `${dateStr}_${timeStr}_${ms}.jpg`;

    const filePath = join(dir, filename);
    writeFileSync(filePath, imageData);

    /** 保存检测结果元数据（JSON 侧文件） */
    if (detections && detections.length > 0) {
      const metaPath = join(dir, `${dateStr}_${timeStr}_${ms}.json`);
      writeFileSync(metaPath, JSON.stringify({
        cameraId,
        timestamp,
        detections,
      }));
    }

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

        /** 尝试读取检测结果标签 */
        let detectionLabels: string | undefined;
        const jsonFile = file.replace(/\.jpg$/, ".json");
        if (files.includes(jsonFile)) {
          try {
            const meta = JSON.parse(readFileSync(join(dir, jsonFile), "utf-8")) as {
              detections: Array<{ label: string }>;
            };
            const labels = [...new Set(meta.detections.map(d => d.label))];
            if (labels.length > 0) detectionLabels = labels.join(", ");
          } catch { /* ignore */ }
        }

        results.push({
          filename: `${camId}/${file}`,
          cameraId: camId,
          timestamp,
          size: stat.size,
          detectionLabels,
        });
      }
    }

    return results.sort((a, b) => b.timestamp - a.timestamp);
  }

  /** 获取快照文件路径 */
  getSnapshotPath(relativePath: string): string {
    return join(this.storagePath, relativePath);
  }

  /** 获取快照的检测结果元数据 */
  getSnapshotMeta(relativePath: string): { cameraId: string; timestamp: number; detections: Detection[] } | null {
    const jsonPath = join(this.storagePath, relativePath.replace(/\.jpg$/, ".json"));
    if (!existsSync(jsonPath)) return null;
    try {
      return JSON.parse(readFileSync(jsonPath, "utf-8"));
    } catch {
      return null;
    }
  }

  /** 清理过期快照（公开，返回清理数量） */
  purge(retentionDays: number): number {
    const cutoff = Date.now() - retentionDays * 86_400_000;
    let count = 0;

    try {
      const camDirs = readdirSync(this.storagePath);
      for (const camDir of camDirs) {
        const camPath = join(this.storagePath, camDir);
        if (!statSync(camPath).isDirectory()) continue;

        const files = readdirSync(camPath);
        for (const file of files) {
          if (!file.endsWith(".jpg") && !file.endsWith(".json")) continue;
          const filePath = join(camPath, file);
          const stat = statSync(filePath);
          if (stat.mtimeMs < cutoff) {
            unlinkSync(filePath);
            if (file.endsWith(".jpg")) count++;
          }
        }
      }
    } catch {
      // ignore
    }
    return count;
  }

  /** 从文件名解析时间戳 */
  private parseTimestamp(filename: string): number {
    const match = filename.match(/^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})/);
    if (!match) return 0;
    const dateStr = `${match[1]}T${match[2]}:${match[3]}:${match[4]}`;
    return new Date(dateStr).getTime();
  }
}
