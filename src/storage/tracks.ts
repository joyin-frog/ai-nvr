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
  /** 当前快照的质量分数（score × box面积） */
  bestSnapshotScore: number;
  /** 感知差异哈希（dHash，64 位，hex string） */
  dhash?: string;
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
   * 新目标：裁剪快照并保存
   * 已有目标：当质量分数更高时自动更新快照
   */
  async upsert(
    trackId: number,
    label: string,
    cameraId: string,
    timestamp: number,
    frameImage: Buffer,
    box: Detection["box"],
    score?: number,
  ): Promise<void> {
    const snapshotScore = this.calcSnapshotScore(box, score ?? 0.5);

    let record = this.tracks.get(trackId);
    if (record) {
      record.lastSeen = timestamp;
      record.hitCount++;
      if (!record.cameraIds.includes(cameraId)) {
        record.cameraIds.push(cameraId);
      }
      /** 质量分数超过当前最佳 20% 时更新快照 */
      if (box && snapshotScore > record.bestSnapshotScore * 1.2) {
        const snapshotFile = await this.cropAndSave(trackId, cameraId, frameImage, box);
        if (snapshotFile) {
          record.snapshotFile = snapshotFile;
          record.bestSnapshotScore = snapshotScore;
          /** 更新 dHash */
          record.dhash = await this.computeDHash(frameImage, box);
        }
      }
      this.scheduleSave();
      return;
    }

    /** 新目标：裁剪快照并保存 */
    const snapshotFile = await this.cropAndSave(trackId, cameraId, frameImage, box);
    /** 计算 dHash */
    const dhash = box ? await this.computeDHash(frameImage, box) : undefined;

    record = {
      trackId,
      label,
      firstSeen: timestamp,
      lastSeen: timestamp,
      hitCount: 1,
      cameraIds: [cameraId],
      snapshotFile,
      bestSnapshotScore: snapshotScore,
      dhash,
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

  /**
   * 尝试为已有目标更新快照
   * 当检测质量高于当前快照时才重新裁剪
   */
  async tryUpdateSnapshot(
    trackId: number,
    cameraId: string,
    frameImage: Buffer,
    box: Detection["box"],
    score: number,
  ): Promise<void> {
    const record = this.tracks.get(trackId);
    if (!record || !box) return;
    const snapshotScore = this.calcSnapshotScore(box, score);
    /** 质量分数超过当前最佳 20% 时更新快照 */
    if (snapshotScore <= record.bestSnapshotScore * 1.2) return;
    const snapshotFile = await this.cropAndSave(trackId, cameraId, frameImage, box);
    if (snapshotFile) {
      record.snapshotFile = snapshotFile;
      record.bestSnapshotScore = snapshotScore;
      this.scheduleSave();
    }
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

  /** 获取包含内部字段的完整记录（含 dhash） */
  getRecord(trackId: number): TrackRecord | undefined {
    return this.tracks.get(trackId);
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

  /** 获取最大的 trackId，用于重启后恢复递增计数器 */
  getMaxTrackId(): number {
    let max = 0;
    for (const id of this.tracks.keys()) {
      if (id > max) max = id;
    }
    return max;
  }

  /** 合并两个追踪目标（将 source 合并到 target） */
  merge(sourceId: number, targetId: number): boolean {
    const source = this.tracks.get(sourceId);
    const target = this.tracks.get(targetId);
    if (!source || !target || sourceId === targetId) return false;

    /** 合并摄像头列表 */
    for (const camId of source.cameraIds) {
      if (!target.cameraIds.includes(camId)) {
        target.cameraIds.push(camId);
      }
    }

    /** 累加出现次数 */
    target.hitCount += source.hitCount;

    /** 更新时间范围 */
    target.firstSeen = Math.min(target.firstSeen, source.firstSeen);
    target.lastSeen = Math.max(target.lastSeen, source.lastSeen);

    /** 如果目标没有快照但源有，使用源的快照 */
    if (!target.snapshotFile && source.snapshotFile) {
      target.snapshotFile = source.snapshotFile;
      target.bestSnapshotScore = source.bestSnapshotScore;
    }

    /** 删除源目标（不删快照，因为可能已转移给 target） */
    this.tracks.delete(sourceId);
    this.scheduleSave();
    return true;
  }

  /** 删除单个追踪目标（包括快照文件） */
  remove(trackId: number): boolean {
    const record = this.tracks.get(trackId);
    if (!record) return false;
    if (record.snapshotFile) {
      const path = join(this.storagePath, record.snapshotFile);
      if (existsSync(path)) unlinkSync(path);
    }
    this.tracks.delete(trackId);
    this.scheduleSave();
    return true;
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

  /**
   * 计算图像的差异哈希（dHash）
   * 缩放到 9x8 灰度，比较相邻像素亮度，生成 64 位哈希
   */
  async computeDHash(frameImage: Buffer, box: Detection["box"]): Promise<string> {
    if (!box) return "";
    const image = sharp(frameImage);
    const meta = await image.metadata();
    if (!meta.width || !meta.height) return "";

    const padW = (box.xmax - box.xmin) * 0.2;
    const padH = (box.ymax - box.ymin) * 0.2;
    const left = Math.max(0, Math.floor((box.xmin - padW) * meta.width));
    const top = Math.max(0, Math.floor((box.ymin - padH) * meta.height));
    const width = Math.min(meta.width - left, Math.ceil((box.xmax - box.xmin + padW * 2) * meta.width));
    const height = Math.min(meta.height - top, Math.ceil((box.ymax - box.ymin + padH * 2) * meta.height));

    if (width < 10 || height < 10) return "";

    const { data, info } = await image
      .extract({ left, top, width, height })
      .resize(9, 8, { fit: "fill" })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    /** dHash: 每行比较相邻像素，左 > 右 = 1 */
    let hash = BigInt(0);
    for (let row = 0; row < info.height; row++) {
      for (let col = 0; col < info.width - 1; col++) {
        const idx = row * info.width + col;
        if (data[idx]! > data[idx + 1]!) {
          hash |= BigInt(1) << BigInt(row * 8 + col);
        }
      }
    }
    return hash.toString(16).padStart(16, "0");
  }

  /**
   * 计算两个 dHash 的汉明距离（不同位的数量）
   */
  static hammingDistance(a: string, b: string): number {
    const ba = BigInt("0x" + a);
    const bb = BigInt("0x" + b);
    let xor = ba ^ bb;
    let count = 0;
    while (xor) {
      count += Number(xor & BigInt(1));
      xor >>= BigInt(1);
    }
    return count;
  }

  /**
   * 查找与指定目标外观相似的已命名目标
   * 返回汉明距离小于阈值的匹配列表
   */
  findSimilar(
    trackId: number,
    cameraId: string,
    label: string,
    dhash: string,
    /** 最大汉明距离（默认 15，64 位中约 23%） */
    maxDistance = 15,
  ): Array<{ trackId: number; customName: string; distance: number }> {
    if (!dhash) return [];
    const results: Array<{ trackId: number; customName: string; distance: number }> = [];
    for (const record of this.tracks.values()) {
      if (record.trackId === trackId) continue;
      if (!record.customName || !record.dhash) continue;
      /** 同标签优先 */
      if (record.label !== label) continue;
      const dist = TrackStorage.hammingDistance(dhash, record.dhash);
      if (dist <= maxDistance) {
        results.push({ trackId: record.trackId, customName: record.customName, distance: dist });
      }
    }
    /** 按距离排序，最近匹配在前 */
    results.sort((a, b) => a.distance - b.distance);
    return results;
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
      .resize(224, 224, { fit: "cover" })
      .jpeg({ quality: 90 })
      .toFile(filePath);

    return filename;
  }

  /** 计算快照质量分数：score × box面积占比（越大越清晰） */
  private calcSnapshotScore(box: Detection["box"], score: number): number {
    if (!box) return 0;
    const area = (box.xmax - box.xmin) * (box.ymax - box.ymin);
    return score * area;
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
      /** 兼容旧数据：没有 bestSnapshotScore 时设为 0（下次高质量帧会自动更新） */
      if (r.bestSnapshotScore === undefined) r.bestSnapshotScore = 0;
      this.tracks.set(r.trackId, r);
    }
  }
}
