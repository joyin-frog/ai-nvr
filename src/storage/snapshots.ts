import { mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync, existsSync, readFileSync, rmSync } from "node:fs";
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

  /** 快照路径缓存：cameraId:timestamp → relativePath（写入时自动填充，避免 existsSync） */
  private pathCache = new Map<string, string>();
  /** 元数据缓存：relativePath → parsed JSON（避免重复 readFileSync） */
  private metaCache = new Map<string, { cameraId: string; timestamp: number; detections: Detection[] } | null>();
  /** 元数据缓存上限 */
  private static readonly META_CACHE_MAX = 2000;

  constructor(storagePath: string, private eventBus: EventBus) {
    this.storagePath = storagePath;
    mkdirSync(storagePath, { recursive: true });
  }

  /** 启动：监听 detect 事件保存原始帧和元数据 */
  start(): void {
    this.eventBus.on("detect", ({ cameraId, timestamp, frameImage, detections }) => {
      /** 0 目标不保存快照 */
      if (!detections || detections.length === 0) return;
      this.saveSnapshot(cameraId, timestamp, frameImage, detections);
    });
    console.log("[Snapshot] 快照存储已启动");
  }

  /** 保存快照（原始帧 + 检测结果 JSON） */
  saveSnapshot(cameraId: string, timestamp: number, frameImage: Buffer, detections?: Detection[]): string {
    const dir = join(this.storagePath, cameraId);
    mkdirSync(dir, { recursive: true });

    const date = new Date(timestamp);
    const dateStr = date.toISOString().slice(0, 10);
    const timeStr = date.toISOString().slice(11, 19).replace(/:/g, "-");
    const ms = String(date.getMilliseconds()).padStart(3, "0");
    const filename = `${dateStr}_${timeStr}_${ms}.jpg`;
    const relativePath = `${cameraId}/${filename}`;

    const filePath = join(dir, filename);
    writeFileSync(filePath, frameImage);

    /** 写入时同步更新路径缓存（写入必然成功，后续查找无需 existsSync） */
    const pathKey = `${cameraId}:${timestamp}`;
    this.pathCache.set(pathKey, relativePath);

    /** 保存检测结果元数据（JSON 侧文件） */
    if (detections && detections.length > 0) {
      const meta = { cameraId, timestamp, detections };
      const metaPath = join(dir, `${dateStr}_${timeStr}_${ms}.json`);
      writeFileSync(metaPath, JSON.stringify(meta));
      /** 同步更新元数据缓存 */
      this.metaCache.set(relativePath, meta);
      if (this.metaCache.size > SnapshotStorage.META_CACHE_MAX) {
        const firstKey = this.metaCache.keys().next().value;
        if (firstKey != null) this.metaCache.delete(firstKey);
      }
    }

    if (process.env.DEBUG) {
      console.log(`[Snapshot] 已保存: ${relativePath} (${frameImage.length} bytes)`);
    }
    return relativePath;
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

  /** 获取某摄像头最新的快照相对路径 */
  getLatestSnapshotPath(cameraId: string): string | null {
    const dir = join(this.storagePath, cameraId);
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir)
      .filter(f => f.endsWith(".jpg"))
      .sort()
      .reverse();
    if (files.length === 0) return null;
    return `${cameraId}/${files[0]}`;
  }

  /** 获取快照文件路径 */
  getSnapshotPath(relativePath: string): string {
    return join(this.storagePath, relativePath);
  }

  /** 获取快照的检测结果元数据（优先内存缓存） */
  getSnapshotMeta(relativePath: string): { cameraId: string; timestamp: number; detections: Detection[] } | null {
    const cached = this.metaCache.get(relativePath);
    if (cached !== undefined) return cached;

    const jsonPath = join(this.storagePath, relativePath.replace(/\.jpg$/, ".json"));
    if (!existsSync(jsonPath)) {
      this.metaCache.set(relativePath, null);
      return null;
    }
    try {
      const meta = JSON.parse(readFileSync(jsonPath, "utf-8")) as { cameraId: string; timestamp: number; detections: Detection[] };
      this.metaCache.set(relativePath, meta);
      if (this.metaCache.size > SnapshotStorage.META_CACHE_MAX) {
        const firstKey = this.metaCache.keys().next().value;
        if (firstKey != null) this.metaCache.delete(firstKey);
      }
      return meta;
    } catch {
      this.metaCache.set(relativePath, null);
      return null;
    }
  }

  /** 删除所有快照数据，返回删除的文件数量 */
  purgeAll(): number {
    let count = 0;
    const camDirs = readdirSync(this.storagePath);
    for (const camDir of camDirs) {
      const camPath = join(this.storagePath, camDir);
      if (!statSync(camPath).isDirectory()) continue;
      rmSync(camPath, { recursive: true, force: true });
      count++;
    }
    this.pathCache.clear();
    this.metaCache.clear();
    return count;
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
            if (file.endsWith(".jpg")) {
              count++;
              /** 清除对应的缓存条目 */
              const relativePath = `${camDir}/${file}`;
              this.metaCache.delete(relativePath);
              const ts = this.parseTimestamp(file);
              if (ts) this.pathCache.delete(`${camDir}:${ts}`);
            }
          }
        }
      }
    } catch {
      // ignore
    }
    return count;
  }

  /** 根据 cameraId + timestamp 查找对应的快照相对路径（优先内存缓存） */
  findSnapshotPath(cameraId: string, timestamp: number): string | null {
    /** 优先查内存缓存（saveSnapshot 写入时已填充，热路径零 I/O） */
    const pathKey = `${cameraId}:${timestamp}`;
    const cached = this.pathCache.get(pathKey);
    if (cached !== undefined) return cached || null;

    const dir = join(this.storagePath, cameraId);
    const date = new Date(timestamp);
    const dateStr = date.toISOString().slice(0, 10);
    const timeStr = date.toISOString().slice(11, 19).replace(/:/g, "-");
    const ms = String(date.getMilliseconds()).padStart(3, "0");
    const filename = `${dateStr}_${timeStr}_${ms}.jpg`;
    const filePath = join(dir, filename);
    if (existsSync(filePath)) {
      const relativePath = `${cameraId}/${filename}`;
      /** 回填缓存（历史数据首次查询后缓存） */
      this.pathCache.set(pathKey, relativePath);
      return relativePath;
    }
    /** 缓存未命中标记（空字符串表示不存在，避免重复 existsSync） */
    this.pathCache.set(pathKey, "");
    return null;
  }

  /** 批量查找快照路径（单次调用，避免 N 次 findSnapshotPath 的 I/O 开销） */
  batchFindSnapshotPaths(entries: Array<{ cameraId: string; timestamp: number }>): Map<string, string | null> {
    const result = new Map<string, string | null>();
    for (const { cameraId, timestamp } of entries) {
      const path = this.findSnapshotPath(cameraId, timestamp);
      result.set(`${cameraId}:${timestamp}`, path);
    }
    return result;
  }

  /** 从文件名解析时间戳 */
  private parseTimestamp(filename: string): number {
    const match = filename.match(/^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})/);
    if (!match) return 0;
    const dateStr = `${match[1]}T${match[2]}:${match[3]}:${match[4]}`;
    return new Date(dateStr).getTime();
  }
}
