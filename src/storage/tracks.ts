import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { type Detection } from "@/ai/types";

/** 追踪目标信息 */
export interface TrackInfo {
  /** 全局唯一 trackId */
  trackId: number;
  /** 目标类别标签 */
  label: string;
  /** 用户自定义名称 */
  customName?: string;
  /** 首次出现时间 */
  firstSeen: number;
  /** 最近出现时间 */
  lastSeen: number;
  /** 出现次数 */
  hitCount: number;
  /** 关联摄像头列表 */
  cameraIds: string[];
  /** 快照文件名（相对于 tracks 目录） */
  snapshotFile?: string;
}

interface TrackRecord {
  trackId: number;
  label: string;
  customName?: string;
  firstSeen: number;
  lastSeen: number;
  hitCount: number;
  cameraIds: string[];
  snapshotFile?: string;
}

const TRACKS_META_FILE = "tracks.json";

/**
 * 追踪目标存储
 * 管理所有被追踪目标的元数据和裁剪快照
 */
export class TrackStorage {
  private storagePath: string;
  private tracks = new Map<number, TrackRecord>();
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(storagePath: string) {
    this.storagePath = storagePath;
    mkdirSync(storagePath, { recursive: true });
    this.loadFromDisk();
  }

  /**
   * 更新追踪目标
   * 当目标出现时调用，更新 lastSeen/hitCount/cameraIds
   * 首次出现时保存裁剪快照
   */
  async upsert(
    trackId: number,
    label: string,
    cameraId: string,
    timestamp: number,
    frameImage: Buffer,
    box: Detection["box"],
  ): Promise<void> {
    let record = this.tracks.get(trackId);
    if (record) {
      record.lastSeen = timestamp;
      record.hitCount++;
      if (!record.cameraIds.includes(cameraId)) {
        record.cameraIds.push(cameraId);
      }
      this.scheduleSave();
      return;
    }

    /** 新目标：裁剪快照并保存 */
    const snapshotFile = await this.cropAndSave(trackId, cameraId, frameImage, box);

    record = {
      trackId,
      label,
      firstSeen: timestamp,
      lastSeen: timestamp,
      hitCount: 1,
      cameraIds: [cameraId],
      snapshotFile,
    };
    this.tracks.set(trackId, record);
    this.scheduleSave();
  }

  /**
   * 批量更新已追踪目标的 lastSeen 和 cameraIds（轻量级，无图片处理）
   * 用于每帧活跃目标的元数据更新
   */
  touchSeen(
    items: Array<{ trackId: number; cameraId: string }>,
    timestamp: number,
  ): void {
    let changed = false;
    for (const item of items) {
      const record = this.tracks.get(item.trackId);
      if (!record) continue;
      record.lastSeen = timestamp;
      record.hitCount++;
      if (!record.cameraIds.includes(item.cameraId)) {
        record.cameraIds.push(item.cameraId);
      }
      changed = true;
    }
    if (changed) this.scheduleSave();
  }

  /** 设置自定义名称 */
  setCustomName(trackId: number, name: string): void {
    const record = this.tracks.get(trackId);
    if (!record) return;
    record.customName = name || undefined;
    this.scheduleSave();
  }

  /** 获取所有追踪目标 */
  listTracks(): TrackInfo[] {
    return [...this.tracks.values()].map(r => ({
      trackId: r.trackId,
      label: r.label,
      customName: r.customName,
      firstSeen: r.firstSeen,
      lastSeen: r.lastSeen,
      hitCount: r.hitCount,
      cameraIds: [...r.cameraIds],
      snapshotFile: r.snapshotFile,
    })).sort((a, b) => b.lastSeen - a.lastSeen);
  }

  /** 获取快照文件路径 */
  getSnapshotPath(filename: string): string {
    return join(this.storagePath, filename);
  }

  /** 获取单个追踪目标 */
  getTrack(trackId: number): TrackInfo | undefined {
    const r = this.tracks.get(trackId);
    if (!r) return undefined;
    return {
      trackId: r.trackId,
      label: r.label,
      customName: r.customName,
      firstSeen: r.firstSeen,
      lastSeen: r.lastSeen,
      hitCount: r.hitCount,
      cameraIds: [...r.cameraIds],
      snapshotFile: r.snapshotFile,
    };
  }

  /** 清理超过 maxAge 天的目标 */
  cleanup(maxAgeDays: number): number {
    const cutoff = Date.now() - maxAgeDays * 86_400_000;
    let removed = 0;
    for (const [id, record] of this.tracks) {
      if (record.lastSeen < cutoff) {
        if (record.snapshotFile) {
          const path = join(this.storagePath, record.snapshotFile);
          if (existsSync(path)) unlinkSync(path);
        }
        this.tracks.delete(id);
        removed++;
      }
    }
    if (removed > 0) this.saveNow();
    return removed;
  }

  /** 从帧中裁剪目标区域并保存为快照 */
  private async cropAndSave(
    trackId: number,
    cameraId: string,
    frameImage: Buffer,
    box: Detection["box"],
  ): Promise<string | undefined> {
    if (!box) return undefined;
    const image = sharp(frameImage);
    const meta = await image.metadata();
    if (!meta.width || !meta.height) return undefined;

    /** 扩大裁剪区域 20%（留上下文） */
    const padW = (box.xmax - box.xmin) * 0.2;
    const padH = (box.ymax - box.ymin) * 0.2;
    const left = Math.max(0, Math.floor((box.xmin - padW) * meta.width));
    const top = Math.max(0, Math.floor((box.ymin - padH) * meta.height));
    const width = Math.min(meta.width - left, Math.ceil((box.xmax - box.xmin + padW * 2) * meta.width));
    const height = Math.min(meta.height - top, Math.ceil((box.ymax - box.ymin + padH * 2) * meta.height));

    if (width < 10 || height < 10) return undefined;

    const filename = `${trackId}_${cameraId}.jpg`;
    const filePath = join(this.storagePath, filename);

    await image
      .extract({ left, top, width, height })
      .resize(160, 160, { fit: "cover" })
      .jpeg({ quality: 85 })
      .toFile(filePath);

    return filename;
  }

  /** 延迟保存（合并多次写入） */
  private scheduleSave(): void {
    this.dirty = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 2000);
  }

  /** 立即保存到磁盘 */
  private saveNow(): void {
    if (!this.dirty) return;
    this.dirty = false;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const data = [...this.tracks.values()];
    writeFileSync(join(this.storagePath, TRACKS_META_FILE), JSON.stringify(data, null, 2));
  }

  /** 从磁盘加载 */
  private loadFromDisk(): void {
    const metaPath = join(this.storagePath, TRACKS_META_FILE);
    if (!existsSync(metaPath)) return;
    const raw = JSON.parse(readFileSync(metaPath, "utf-8")) as TrackRecord[];
    for (const r of raw) {
      this.tracks.set(r.trackId, r);
    }
  }
}
