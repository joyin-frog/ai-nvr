import { type Detection } from "@/ai/types";
import { type StorageFs } from "@/storage/storage-fs";
import { join } from "node:path";
import sharp from "sharp";

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
 * 通过 StorageFs 统一管理文件 I/O 和索引
 */
export class SnapshotStorage {
  /** 存储文件系统 */
  private storageFs: StorageFs;
  /** 索引 category 名称 */
  private category: string;
  /** 磁盘上的子目录名 */
  private dirName: string;

  /** 快照路径缓存：cameraId:timestamp → relativePath（写入时自动填充） */
  private pathCache = new Map<string, string>();
  /** 元数据缓存：relativePath → parsed JSON */
  private metaCache = new Map<string, { cameraId: string; timestamp: number; detections: Detection[] } | null>();
  /** 元数据缓存上限 */
  private static readonly META_CACHE_MAX = 2000;

  /**
   * @param storageFs 存储文件系统
   * @param category SQLite 索引的 category 名称
   * @param dirName 磁盘上的子目录名（默认与 category 相同）
   */
  constructor(storageFs: StorageFs, category: string = "detection-snapshots", dirName?: string) {
    this.storageFs = storageFs;
    this.category = category;
    this.dirName = dirName ?? category;
  }

  /** 启动：初始化存储目录 */
  async start(): Promise<void> {
    await this.storageFs.ensureDir(`${this.dirName}/.keep`);
    console.log("[Snapshot] 快照存储已启动");
  }

  /** 保存快照（原始帧 + 检测结果 JSON） — 异步 */
  async saveSnapshot(cameraId: string, timestamp: number, frameImage: Buffer, detections?: Detection[]): Promise<string> {
    const d = new Date(timestamp);
    const pad = (n: number) => String(n).padStart(2, "0");
    const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const timeStr = `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
    const ms = String(d.getMilliseconds()).padStart(3, "0");
    const filename = `${dateStr}_${timeStr}_${ms}`;
    const relativePath = `${cameraId}/${filename}`;

    /** 预填充路径缓存（写入是异步的，事件推送在写入完成前就需要查找） */
    const pathKey = `${cameraId}:${timestamp}`;
    this.pathCache.set(pathKey, `${relativePath}.jpg`);

    const labels = detections && detections.length > 0
      ? [...new Set(detections.map(d => d.label))].join(", ")
      : undefined;

    /** 缩放+压缩：最大宽度 960px，JPEG quality 75，减少磁盘占用 */
    const resized = await sharp(frameImage, { failOn: "none" })
      .resize(960, 960, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 75 })
      .toBuffer();

    /** 写入 JPEG */
    await this.storageFs.writeFile(
      `${this.dirName}/${relativePath}.jpg`,
      resized,
      {
        category: this.category,
        cameraId,
        createdAt: timestamp,
        extra: labels ? JSON.stringify({ labels }) : undefined,
      },
    );

    /** 写入检测结果元数据 JSON */
    if (detections && detections.length > 0) {
      const meta = { cameraId, timestamp, detections };
      await this.storageFs.writeFile(
        `${this.dirName}/${relativePath}.json`,
        JSON.stringify(meta),
      );
      this.metaCache.set(relativePath, meta);
      if (this.metaCache.size > SnapshotStorage.META_CACHE_MAX) {
        const firstKey = this.metaCache.keys().next().value;
        if (firstKey != null) this.metaCache.delete(firstKey);
      }
    }

    if (process.env.DEBUG) {
      console.log(`[Snapshot] 已保存: ${relativePath}.jpg (${frameImage.length} bytes)`);
    }
    return relativePath;
  }

  /** 列出快照 — 从 SQLite 索引查询 */
  listSnapshots(cameraId?: string): SnapshotInfo[] {
    const entries = this.storageFs.fileIndex.listFiles({
      category: this.category,
      cameraId: cameraId ?? undefined,
    });

    return entries.map(e => ({
      filename: `${e.relativePath}.jpg`,
      cameraId: e.cameraId ?? "",
      timestamp: e.createdAt ?? 0,
      size: e.size,
      detectionLabels: e.extra ? (JSON.parse(e.extra) as { labels?: string }).labels : undefined,
    })).sort((a, b) => b.timestamp - a.timestamp);
  }

  /** 获取某摄像头最新的快照相对路径 */
  getLatestSnapshotPath(cameraId: string): string | null {
    const latest = this.storageFs.fileIndex.getLatestFile(this.category, cameraId);
    return latest ? `${latest.relativePath}` : null;
  }

  /** 获取快照文件/目录的绝对路径（含子目录路径时自动补 .jpg） */
  getSnapshotPath(relativePath: string): string {
    const hasExt = relativePath.endsWith(".jpg") || relativePath.endsWith(".json");
    const needsSuffix = !hasExt && relativePath.includes("/");
    const path = needsSuffix ? `${relativePath}.jpg` : relativePath;
    return this.storageFs.resolve(join(this.dirName, path));
  }

  /** 获取快照的检测结果元数据（优先内存缓存） */
  async getSnapshotMeta(relativePath: string): Promise<{ cameraId: string; timestamp: number; detections: Detection[] } | null> {
    const cached = this.metaCache.get(relativePath);
    if (cached !== undefined) return cached;

    const jsonPath = `${this.dirName}/${relativePath.replace(/\.jpg$/, ".json")}`;
    const exists = await this.storageFs.exists(jsonPath);
    if (!exists) {
      this.metaCache.set(relativePath, null);
      return null;
    }
    try {
      const data = await this.storageFs.readFile(jsonPath);
      const meta = JSON.parse(data.toString("utf-8")) as { cameraId: string; timestamp: number; detections: Detection[] };
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
  async purgeAll(): Promise<number> {
    const count = await this.storageFs.deleteAllFiles(this.category);
    this.pathCache.clear();
    this.metaCache.clear();
    return count;
  }

  /** 清理过期快照 */
  async purge(retentionDays: number): Promise<number> {
    const cutoff = Date.now() - retentionDays * 86_400_000;
    const deleted = await this.storageFs.deleteExpiredFiles(this.category, cutoff);
    for (const [key, value] of this.metaCache) {
      if (value && value.timestamp < cutoff) this.metaCache.delete(key);
    }
    return deleted;
  }

  /** 根据 cameraId + timestamp 查找对应的快照相对路径（优先内存缓存） */
  findSnapshotPath(cameraId: string, timestamp: number): string | null {
    const pathKey = `${cameraId}:${timestamp}`;
    const cached = this.pathCache.get(pathKey);
    if (cached !== undefined) return cached || null;

    const entries = this.storageFs.fileIndex.listFiles({
      category: this.category,
      cameraId,
      since: timestamp,
      until: timestamp + 1,
      limit: 1,
    });
    if (entries.length > 0) {
      const path = entries[0]!.relativePath;
      const fullPath = path.endsWith(".jpg") ? path : `${path}.jpg`;
      this.pathCache.set(pathKey, fullPath);
      return fullPath;
    }
    this.pathCache.set(pathKey, "");
    return null;
  }

  /** 批量查找快照路径 */
  batchFindSnapshotPaths(entries: Array<{ cameraId: string; timestamp: number }>): Map<string, string | null> {
    const result = new Map<string, string | null>();
    for (const { cameraId, timestamp } of entries) {
      const path = this.findSnapshotPath(cameraId, timestamp);
      result.set(`${cameraId}:${timestamp}`, path);
    }
    return result;
  }
}
