import { mkdir, writeFile, readFile, unlink, readdir } from "node:fs/promises";
import { writeFileSync } from "node:fs";
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
  /** 主色调名称（从 HSV 直方图提取，如 "red", "blue", "green"） */
  dominantColor?: string;
  /** CLIP 零样本分类的语义标签（如 "a black dog"） */
  semanticLabel?: string;
}

/** 备选指纹（每个目标最多保留 2 个备选 + 1 个主指纹） */
interface AltFingerprint {
  dhash: string;
  colorHist?: number[];
  lbpHist?: number[];
  /** 质量分数 */
  score: number;
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
  /** HSV 颜色直方图（H=8 bins, S=4 bins, V=4 bins，共 128 维，量化为 uint8[]） */
  colorHist?: number[];
  /** LBP 纹理直方图（uniform 模式 59 bins，量化为 uint8[]） */
  lbpHist?: number[];
  /** 备选指纹列表（最多 2 个，不同角度/姿态的快照指纹） */
  altFingerprints?: AltFingerprint[];
  /** CLIP 零样本分类的语义标签（如 "a black dog"） */
  semanticLabel?: string;
  /** CLIP 图像嵌入向量（512 维，L2 归一化），用于高精度 ReID */
  clipEmbedding?: number[];
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
  /** listTracks 缓存 */
  private listCache: TrackInfo[] | null = null;
  private listCacheExpiry = 0;
  private static readonly LIST_CACHE_TTL = 5000;

  constructor(storagePath: string) {
    this.storagePath = storagePath;
    /** 异步初始化：创建目录 + 加载数据，不阻塞启动 */
    this.init();
  }

  /** 异步初始化 */
  private async init(): Promise<void> {
    await mkdir(this.storagePath, { recursive: true });
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

    const existingRecord = this.tracks.get(trackId);
    if (existingRecord) {
      existingRecord.lastSeen = timestamp;
      existingRecord.hitCount++;
      if (!existingRecord.cameraIds.includes(cameraId)) {
        existingRecord.cameraIds.push(cameraId);
      }
      /** 质量分数超过当前最佳 20% 时更新快照 */
      if (box && snapshotScore > existingRecord.bestSnapshotScore * 1.2) {
        const snapshotFile = await this.cropAndSave(trackId, cameraId, frameImage, box);
        if (snapshotFile) {
          /** 旧指纹移入备选列表（保留多角度信息） */
          if (existingRecord.dhash) {
            const alt: AltFingerprint = { dhash: existingRecord.dhash, colorHist: existingRecord.colorHist, lbpHist: existingRecord.lbpHist, score: existingRecord.bestSnapshotScore };
            if (!existingRecord.altFingerprints) existingRecord.altFingerprints = [];
            /** 跳过与现有备选 dHash 相同的（避免重复） */
            const isDuplicate = existingRecord.altFingerprints.some(a => a.dhash === existingRecord.dhash);
            if (!isDuplicate) {
              existingRecord.altFingerprints.push(alt);
              /** 最多保留 2 个备选（按质量降序） */
              existingRecord.altFingerprints.sort((a, b) => b.score - a.score);
              if (existingRecord.altFingerprints.length > 2) existingRecord.altFingerprints.length = 2;
            }
          }
          existingRecord.snapshotFile = snapshotFile;
          existingRecord.bestSnapshotScore = snapshotScore;
          /** 更新指纹（单次并行计算） */
          const fp = await this.computeFingerprints(frameImage, box);
          existingRecord.dhash = fp.dhash;
          existingRecord.colorHist = fp.colorHist;
          existingRecord.lbpHist = fp.lbpHist;
        }
      }
      this.scheduleSave();
      return;
    }

    /** 新目标：裁剪快照并保存 */
    const snapshotFile = await this.cropAndSave(trackId, cameraId, frameImage, box);
    /** 计算指纹（单次并行计算） */
    const fp = box ? await this.computeFingerprints(frameImage, box) : { dhash: undefined as string | undefined, colorHist: undefined as number[] | undefined, lbpHist: undefined as number[] | undefined };

    const newRecord: TrackRecord = {
      trackId,
      label,
      firstSeen: timestamp,
      lastSeen: timestamp,
      hitCount: 1,
      cameraIds: [cameraId],
      snapshotFile,
      bestSnapshotScore: snapshotScore,
      dhash: fp.dhash,
      colorHist: fp.colorHist,
      lbpHist: fp.lbpHist,
    };
    this.tracks.set(trackId, newRecord);
    this.invalidateListCache();
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
  ): Promise<boolean> {
    const record = this.tracks.get(trackId);
    if (!record || !box) return false;
    const snapshotScore = this.calcSnapshotScore(box, score);
    /** 质量分数超过当前最佳 20% 时更新快照 */
    if (snapshotScore <= record.bestSnapshotScore * 1.2) return false;
    const snapshotFile = await this.cropAndSave(trackId, cameraId, frameImage, box);
    if (snapshotFile) {
      /** 旧指纹移入备选列表 */
      if (record.dhash) {
        const alt: AltFingerprint = { dhash: record.dhash, colorHist: record.colorHist, lbpHist: record.lbpHist, score: record.bestSnapshotScore };
        if (!record.altFingerprints) record.altFingerprints = [];
        const isDup = record.altFingerprints.some(a => a.dhash === record.dhash);
        if (!isDup) {
          record.altFingerprints.push(alt);
          record.altFingerprints.sort((a, b) => b.score - a.score);
          if (record.altFingerprints.length > 2) record.altFingerprints.length = 2;
        }
      }
      record.snapshotFile = snapshotFile;
      record.bestSnapshotScore = snapshotScore;
      /** 同时更新指纹（单次并行计算） */
      const fp = await this.computeFingerprints(frameImage, box);
      record.dhash = fp.dhash;
      record.colorHist = fp.colorHist;
      record.lbpHist = fp.lbpHist;
      this.scheduleSave();
      return true;
    }
    return false;
  }

  /** 设置自定义名称 */
  setCustomName(trackId: number, name: string): void {
    const record = this.tracks.get(trackId);
    if (!record) return;
    record.customName = name || undefined;
    this.invalidateListCache();
    this.scheduleSave();
  }

  /** 设置语义标签（CLIP 零样本分类结果） */
  setSemanticLabel(trackId: number, label: string): void {
    const record = this.tracks.get(trackId);
    if (!record || record.semanticLabel === label) return;
    record.semanticLabel = label;
    this.scheduleSave();
  }

  /** 设置 CLIP 图像嵌入向量（用于高精度 ReID） */
  setClipEmbedding(trackId: number, embedding: number[]): void {
    const record = this.tracks.get(trackId);
    if (!record) return;
    record.clipEmbedding = embedding;
    this.scheduleSave();
  }

  /** 获取所有追踪目标（5 秒缓存，避免每次请求重建列表） */
  listTracks(): TrackInfo[] {
    const now = Date.now();
    if (this.listCache && now < this.listCacheExpiry) return this.listCache;

    const result = [...this.tracks.values()].map(r => ({
      trackId: r.trackId,
      label: r.label,
      customName: r.customName,
      firstSeen: r.firstSeen,
      lastSeen: r.lastSeen,
      hitCount: r.hitCount,
      cameraIds: [...r.cameraIds],
      snapshotFile: r.snapshotFile,
      dominantColor: r.colorHist ? TrackStorage.extractDominantColor(r.colorHist) : undefined,
      semanticLabel: r.semanticLabel,
    })).sort((a, b) => b.lastSeen - a.lastSeen);

    this.listCache = result;
    this.listCacheExpiry = now + TrackStorage.LIST_CACHE_TTL;
    return result;
  }

  /** 使 listTracks 缓存失效 */
  invalidateListCache(): void {
    this.listCache = null;
    this.listCacheExpiry = 0;
  }

  /** 获取快照文件路径 */
  getSnapshotPath(filename: string): string {
    return join(this.storagePath, filename);
  }

  /** 获取包含内部字段的完整记录（含 dhash） */
  getRecord(trackId: number): TrackRecord | undefined {
    return this.tracks.get(trackId);
  }

  /**
   * 批量获取未命名目标的匹配建议
   * 优先使用 CLIP embedding，回退到 dHash + 颜色 + LBP
   */
  getSuggestions(): Array<{ trackId: number; label: string; suggestedName: string; distance: number }> {
    /** 收集所有已命名目标（有 dhash 或 CLIP embedding） */
    const named: TrackRecord[] = [];
    for (const r of this.tracks.values()) {
      if (r.customName && (r.dhash || r.clipEmbedding?.length)) named.push(r);
    }
    if (named.length === 0) return [];

    const results: Array<{ trackId: number; label: string; suggestedName: string; distance: number }> = [];
    for (const r of this.tracks.values()) {
      if (r.customName || (!r.dhash && !r.clipEmbedding?.length)) continue;
      let bestDist = Infinity;
      let bestName = "";
      for (const n of named) {
        const combinedDist = TrackStorage.computeBestDistance(r, n);

        /** 同标签直接比较；跨标签需要更近距离才接受 */
        const threshold = n.label === r.label ? 0.4 : 0.3;
        if (combinedDist < bestDist && combinedDist <= threshold) {
          bestDist = combinedDist;
          bestName = n.customName!;
        }
      }
      if (bestName) {
        results.push({ trackId: r.trackId, label: r.label, suggestedName: bestName, distance: bestDist });
      }
    }
    return results;
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
      dominantColor: r.colorHist ? TrackStorage.extractDominantColor(r.colorHist) : undefined,
      semanticLabel: r.semanticLabel,
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

    /** 继承 CLIP embedding（目标没有时使用源的） */
    if (!target.clipEmbedding?.length && source.clipEmbedding?.length) {
      target.clipEmbedding = source.clipEmbedding;
    }

    /** 合并备选指纹 */
    const sourceFps: AltFingerprint[] = [];
    if (source.dhash) sourceFps.push({ dhash: source.dhash, colorHist: source.colorHist, lbpHist: source.lbpHist, score: source.bestSnapshotScore });
    if (source.altFingerprints) sourceFps.push(...source.altFingerprints);
    if (sourceFps.length > 0) {
      if (!target.altFingerprints) target.altFingerprints = [];
      for (const fp of sourceFps) {
        const isDup = target.altFingerprints.some(a => a.dhash === fp.dhash) || fp.dhash === target.dhash;
        if (!isDup) target.altFingerprints.push(fp);
      }
      target.altFingerprints.sort((a, b) => b.score - a.score);
      if (target.altFingerprints.length > 2) target.altFingerprints.length = 2;
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
      unlink(path).catch(() => {});
    }
    this.tracks.delete(trackId);
    this.scheduleSave();
    return true;
  }

  /**
   * 删除所有追踪数据（快照文件 + 元数据），返回删除的记录数量
   */
  async purgeAll(): Promise<number> {
    const count = this.tracks.size;
    /** 删除所有快照文件（.jpg） */
    const files = await readdir(this.storagePath);
    for (const file of files) {
      if (file === TRACKS_META_FILE) continue;
      if (file.endsWith(".jpg")) {
        await unlink(join(this.storagePath, file));
      }
    }
    this.tracks.clear();
    this.invalidateListCache();
    this.saveNow();
    return count;
  }

  /**
   * 清理超期目标
   * 已命名目标保留期延长 3 倍（用户手动命名的目标价值更高）
   */
  cleanup(maxAgeDays: number): number {
    const cutoff = Date.now() - maxAgeDays * 86_400_000;
    const namedCutoff = Date.now() - maxAgeDays * 3 * 86_400_000;
    let removed = 0;
    for (const [id, record] of this.tracks) {
      const threshold = record.customName ? namedCutoff : cutoff;
      if (record.lastSeen < threshold) {
        if (record.snapshotFile) {
          const path = join(this.storagePath, record.snapshotFile);
          unlink(path).catch(() => {});
        }
        this.tracks.delete(id);
        removed++;
      }
    }
    if (removed > 0) this.saveNow();
    return removed;
  }

  /**
   * 并行计算三种指纹（dHash + 颜色直方图 + LBP）
   * 共享一次 metadata 调用和 extract 区域计算，3x → 1x I/O 开销
   */
  async computeFingerprints(frameImage: Buffer, box: Detection["box"]): Promise<{ dhash: string; colorHist: number[]; lbpHist: number[] }> {
    if (!box) return { dhash: "", colorHist: [], lbpHist: [] };
    const meta = await sharp(frameImage).metadata();
    if (!meta.width || !meta.height) return { dhash: "", colorHist: [], lbpHist: [] };

    const padW = (box.xmax - box.xmin) * 0.2;
    const padH = (box.ymax - box.ymin) * 0.2;
    const left = Math.max(0, Math.floor((box.xmin - padW) * meta.width));
    const top = Math.max(0, Math.floor((box.ymin - padH) * meta.height));
    const width = Math.min(meta.width - left, Math.ceil((box.xmax - box.xmin + padW * 2) * meta.width));
    const height = Math.min(meta.height - top, Math.ceil((box.ymax - box.ymin + padH * 2) * meta.height));

    if (width < 10 || height < 10) return { dhash: "", colorHist: [], lbpHist: [] };

    const extractRegion = { left, top, width, height };
    const [dhash, colorHist, lbpHist] = await Promise.all([
      this.computeDHashExtract(frameImage, extractRegion),
      this.computeColorHistExtract(frameImage, extractRegion),
      this.computeLBPExtract(frameImage, extractRegion),
    ]);
    return { dhash, colorHist, lbpHist };
  }

  /** 计算图像的差异哈希（委托给 computeFingerprints） */
  async computeDHash(frameImage: Buffer, box: Detection["box"]): Promise<string> {
    const { dhash } = await this.computeFingerprints(frameImage, box);
    return dhash;
  }

  /** 内部：从预计算区域提取 dHash */
  private async computeDHashExtract(frameImage: Buffer, region: { left: number; top: number; width: number; height: number }): Promise<string> {
    const { data, info } = await sharp(frameImage)
      .extract(region)
      .resize(9, 8, { fit: "fill" })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

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

  /** 计算 HSV 颜色直方图（委托给 computeFingerprints） */
  async computeColorHist(frameImage: Buffer, box: Detection["box"]): Promise<number[]> {
    const { colorHist } = await this.computeFingerprints(frameImage, box);
    return colorHist;
  }

  /** 内部：从预计算区域提取颜色直方图 */
  private async computeColorHistExtract(frameImage: Buffer, region: { left: number; top: number; width: number; height: number }): Promise<number[]> {
    const { data, info } = await sharp(frameImage)
      .extract(region)
      .resize(32, 32, { fit: "fill" })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const bins = new Float64Array(128);
    let totalPixels = 0;

    for (let i = 0; i < data.length; i += info.channels) {
      const r = data[i]! / 255;
      const g = data[i + 1]! / 255;
      const b = data[i + 2]! / 255;

      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const d = max - min;
      const v = max;
      const s = max === 0 ? 0 : d / max;
      let h = 0;
      if (d !== 0) {
        if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        else if (max === g) h = ((b - r) / d + 2) / 6;
        else h = ((r - g) / d + 4) / 6;
      }

      const hBin = Math.min(7, Math.floor(h * 8));
      const sBin = Math.min(3, Math.floor(s * 4));
      const vBin = Math.min(3, Math.floor(v * 4));
      bins[hBin * 16 + sBin * 4 + vBin]!++;
      totalPixels++;
    }

    if (totalPixels === 0) return [];

    const result: number[] = new Array(128);
    for (let i = 0; i < 128; i++) {
      result[i] = Math.round((bins[i]! / totalPixels) * 255);
    }
    return result;
  }

  /**
   * 计算两个颜色直方图的卡方距离
   * 返回 0-1 之间的归一化距离（0=完全相同，1=完全不同）
   */
  static colorHistDistance(a: number[], b: number[]): number {
    if (a.length !== 128 || b.length !== 128) return 1;
    let chiSq = 0;
    for (let i = 0; i < 128; i++) {
      const ai = a[i]! / 255;
      const bi = b[i]! / 255;
      const sum = ai + bi;
      if (sum > 0) {
        chiSq += ((ai - bi) * (ai - bi)) / sum;
      }
    }
    return Math.min(1, chiSq / 2);
  }

  /** 计算 LBP 纹理直方图（委托给 computeFingerprints） */
  async computeLBP(frameImage: Buffer, box: Detection["box"]): Promise<number[]> {
    const { lbpHist } = await this.computeFingerprints(frameImage, box);
    return lbpHist;
  }

  /** 内部：从预计算区域提取 LBP 直方图 */
  private async computeLBPExtract(frameImage: Buffer, region: { left: number; top: number; width: number; height: number }): Promise<number[]> {
    const { data, info } = await sharp(frameImage)
      .extract(region)
      .resize(32, 32, { fit: "fill" })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const HIST_BINS = 59;
    const bins = new Float64Array(HIST_BINS);
    let totalPixels = 0;

    for (let y = 1; y < info.height - 1; y++) {
      for (let x = 1; x < info.width - 1; x++) {
        const center = data[y * info.width + x]!;
        const neighbors = [
          data[(y - 1) * info.width + x + 1]!,
          data[y * info.width + x + 1]!,
          data[(y + 1) * info.width + x + 1]!,
          data[(y + 1) * info.width + x]!,
          data[(y + 1) * info.width + x - 1]!,
          data[y * info.width + x - 1]!,
          data[(y - 1) * info.width + x - 1]!,
          data[(y - 1) * info.width + x]!,
        ];

        let lbpVal = 0;
        for (let i = 0; i < 8; i++) {
          if (neighbors[i]! >= center) lbpVal |= (1 << i);
        }

        const bin = TrackStorage.lbpToUniform(lbpVal);
        bins[bin]!++;
        totalPixels++;
      }
    }

    if (totalPixels === 0) return [];

    const result: number[] = new Array(HIST_BINS);
    for (let i = 0; i < HIST_BINS; i++) {
      result[i] = Math.round((bins[i]! / totalPixels) * 255);
    }
    return result;
  }

  /**
   * 将 LBP 值映射到 uniform 模式索引（0-58）
   * Uniform 模式：0→1 跳变次数 ≤ 2
   */
  private static lbpToUniform(lbp: number): number {
    /** 计算 0→1 的跳变次数 */
    let transitions = 0;
    for (let i = 0; i < 8; i++) {
      const curr = (lbp >> i) & 1;
      const next = (lbp >> ((i + 1) % 8)) & 1;
      if (curr !== next) transitions++;
    }
    /** 非 uniform 模式 → bin 58 */
    if (transitions > 2) return 58;
    /** uniform 模式 → 计算 1 的位数 */
    let ones = 0;
    for (let i = 0; i < 8; i++) {
      if ((lbp >> i) & 1) ones++;
    }
    /** ones=0 → bin 0, ones=1 → bin 1-8, ones=2 → bin 9-16, ... */
    /** 简化：直接用 ones 作为索引（0-8 映射到 0-8），其余 uniform 模式按顺序 */
    if (ones <= 1) return ones;
    if (ones === 7) return 57;
    if (ones === 8) return 0;
    /** ones 2-6：按旋转角度排序 */
    return ones - 2 + 9;
  }

  /**
   * 计算两个 LBP 直方图的卡方距离
   * 返回 0-1 归一化距离
   */
  static lbpDistance(a: number[], b: number[]): number {
    if (a.length !== 59 || b.length !== 59) return 1;
    let chiSq = 0;
    for (let i = 0; i < 59; i++) {
      const ai = a[i]! / 255;
      const bi = b[i]! / 255;
      const sum = ai + bi;
      if (sum > 0) {
        chiSq += ((ai - bi) * (ai - bi)) / sum;
      }
    }
    return Math.min(1, chiSq / 2);
  }

  /**
   * 计算综合外观距离（dHash + 颜色 + LBP 三维特征融合）
   * 权重：dHash 0.35 + 颜色 0.35 + LBP 0.30
   * 缺少某个特征时，其权重分配给已有特征
   */
  static computeAppearanceDistance(
    dhashA: string, dhashB: string,
    colorA?: number[], colorB?: number[],
    lbpA?: number[], lbpB?: number[],
  ): number {
    const dhashDist = TrackStorage.hammingDistance(dhashA, dhashB) / 64;
    const hasColor = colorA && colorA.length === 128 && colorB && colorB.length === 128;
    const hasLbp = lbpA && lbpA.length === 59 && lbpB && lbpB.length === 59;

    if (hasColor && hasLbp) {
      const colorDist = TrackStorage.colorHistDistance(colorA!, colorB!);
      const lbpDist = TrackStorage.lbpDistance(lbpA!, lbpB!);
      return dhashDist * 0.35 + colorDist * 0.35 + lbpDist * 0.30;
    }
    if (hasColor) {
      const colorDist = TrackStorage.colorHistDistance(colorA!, colorB!);
      return dhashDist * 0.50 + colorDist * 0.50;
    }
    if (hasLbp) {
      const lbpDist = TrackStorage.lbpDistance(lbpA!, lbpB!);
      return dhashDist * 0.55 + lbpDist * 0.45;
    }
    return dhashDist;
  }

  /**
   * 计算两个目标之间的最优距离（主指纹 + 备选指纹取最小值）
   * 每个目标最多 3 个指纹（1 主 + 2 备选），取所有组合中的最小距离
   * 优先使用 CLIP embedding（高精度语义匹配），否则回退到传统特征
   */
  static computeBestDistance(
    recA: { dhash?: string; colorHist?: number[]; lbpHist?: number[]; altFingerprints?: AltFingerprint[]; clipEmbedding?: number[] },
    recB: { dhash?: string; colorHist?: number[]; lbpHist?: number[]; altFingerprints?: AltFingerprint[]; clipEmbedding?: number[] },
  ): number {
    /** CLIP embedding 优先：双方都有嵌入时直接用余弦距离（1 - cosine_similarity） */
    if (recA.clipEmbedding?.length && recB.clipEmbedding?.length) {
      return TrackStorage.clipEmbeddingDistance(recA.clipEmbedding, recB.clipEmbedding);
    }
    /** 回退到传统指纹匹配 */
    if (!recA.dhash || !recB.dhash) return 1;
    let best = TrackStorage.computeAppearanceDistance(
      recA.dhash, recB.dhash, recA.colorHist, recB.colorHist, recA.lbpHist, recB.lbpHist,
    );
    /** 将 B 的备选指纹与 A 的主指纹比较 */
    if (recB.altFingerprints) {
      for (const alt of recB.altFingerprints) {
        const d = TrackStorage.computeAppearanceDistance(
          recA.dhash, alt.dhash, recA.colorHist, alt.colorHist, recA.lbpHist, alt.lbpHist,
        );
        if (d < best) best = d;
      }
    }
    /** 将 A 的备选指纹与 B 的主指纹比较 */
    if (recA.altFingerprints) {
      for (const alt of recA.altFingerprints) {
        const d = TrackStorage.computeAppearanceDistance(
          alt.dhash, recB.dhash!, alt.colorHist, recB.colorHist, alt.lbpHist, recB.lbpHist,
        );
        if (d < best) best = d;
      }
    }
    return best;
  }

  /**
   * 计算两个 CLIP embedding 的余弦距离（1 - cosine_similarity）
   * 向量已 L2 归一化，余弦距离 = 1 - 点积
   */
  static clipEmbeddingDistance(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 1;
    let dot = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i]! * b[i]!;
    }
    /** 夹紧到 [0, 2] 范围（浮点误差可能导致轻微超出） */
    return Math.max(0, Math.min(2, 1 - dot));
  }

  /**
   * HSV 色相范围 → 颜色名称
   * H 在 HSV 空间中范围是 0-1，对应 0°-360°
   */
  private static readonly HUE_NAMES: Array<{ max: number; name: string }> = [
    { max: 1 / 12, name: "red" },
    { max: 2 / 12, name: "orange" },
    { max: 3 / 12, name: "yellow" },
    { max: 4 / 12, name: "lime" },
    { max: 5 / 12, name: "green" },
    { max: 7 / 12, name: "cyan" },
    { max: 9 / 12, name: "blue" },
    { max: 10 / 12, name: "purple" },
    { max: 11 / 12, name: "pink" },
    { max: 1, name: "red" },
  ];

  /**
   * 从 HSV 颜色直方图中提取主色调名称
   * 找出像素占比最大的色相区间
   */
  static extractDominantColor(hist: number[]): string {
    if (hist.length !== 128) return "gray";

    /** 按 H bin (0-7) 汇总所有 S/V 的像素量 */
    const hueBins = new Float64Array(8);
    let totalColorful = 0;

    for (let h = 0; h < 8; h++) {
      for (let s = 1; s < 4; s++) { /** s=0 是低饱和度，跳过 */
        for (let v = 1; v < 4; v++) { /** v=0 是低亮度，跳过 */
          const idx = h * 16 + s * 4 + v;
          hueBins[h]! += hist[idx]!;
          totalColorful += hist[idx]!;
        }
      }
    }

    /** 彩色像素不足 20% → 灰色/黑白 */
    let totalPixels = 0;
    for (let i = 0; i < 128; i++) totalPixels += hist[i]!;
    if (totalPixels === 0 || totalColorful / totalPixels < 0.2) return "gray";

    /** 找最大色相 bin */
    let maxH = 0;
    let maxVal = 0;
    for (let h = 0; h < 8; h++) {
      if (hueBins[h]! > maxVal) {
        maxVal = hueBins[h]!;
        maxH = h;
      }
    }

    /** bin index → 色相中心值 (0-1) */
    const hueCenter = (maxH + 0.5) / 8;
    for (const entry of TrackStorage.HUE_NAMES) {
      if (hueCenter <= entry.max) return entry.name;
    }
    return "gray";
  }

  /**
   * 查找与指定目标外观相似的已命名目标
   * 优先使用 CLIP embedding（高精度），回退到 dHash + 颜色 + LBP
   */
  findSimilar(
    trackId: number,
    cameraId: string,
    label: string,
    dhash: string,
    /** 最大综合距离（0-1，默认 0.4） */
    maxDistance = 0.4,
    /** 颜色直方图（可选，提供时参与匹配） */
    colorHist?: number[],
    /** LBP 纹理直方图（可选，提供时参与匹配） */
    lbpHist?: number[],
    /** CLIP 图像嵌入向量（可选，提供时优先使用） */
    clipEmbedding?: number[],
  ): Array<{ trackId: number; customName: string; distance: number }> {
    if (!dhash && !clipEmbedding?.length) return [];

    /** 当前查询目标的完整指纹 */
    const queryRec = { dhash, colorHist, lbpHist, clipEmbedding };

    /** 同标签匹配结果 + 跨标签匹配结果 */
    const sameLabel: Array<{ trackId: number; customName: string; distance: number }> = [];
    const crossLabel: Array<{ trackId: number; customName: string; distance: number }> = [];

    /** CLIP embedding 匹配时使用更严格的阈值（语义距离更可靠） */
    const hasClip = !!clipEmbedding?.length;
    const effectiveMaxDist = hasClip ? Math.min(maxDistance, 0.35) : maxDistance;

    for (const record of this.tracks.values()) {
      if (record.trackId === trackId) continue;
      if (!record.customName) continue;
      /** 双方都没有 CLIP embedding 且没有 dHash 时跳过 */
      if (!record.clipEmbedding?.length && !record.dhash) continue;

      /** 使用最优距离（优先 CLIP embedding） */
      const combinedDist = TrackStorage.computeBestDistance(queryRec, record);

      if (record.label === label) {
        if (combinedDist <= effectiveMaxDist) {
          sameLabel.push({ trackId: record.trackId, customName: record.customName, distance: combinedDist });
        }
      } else {
        if (combinedDist <= effectiveMaxDist * 1.2) {
          crossLabel.push({ trackId: record.trackId, customName: record.customName, distance: combinedDist });
        }
      }
    }

    if (sameLabel.length > 0) {
      sameLabel.sort((a, b) => a.distance - b.distance);
      return sameLabel;
    }

    crossLabel.sort((a, b) => a.distance - b.distance);
    return crossLabel;
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

  /** 立即保存到磁盘（异步，不阻塞调用方） */
  private saveNow(): void {
    if (!this.dirty) return;
    this.dirty = false;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const data = [...this.tracks.values()];
    writeFile(join(this.storagePath, TRACKS_META_FILE), JSON.stringify(data)).catch((err) => {
      console.error("[TrackStorage] 保存元数据失败:", err instanceof Error ? err.message : String(err));
      this.dirty = true;
    });
  }

  /** 清理定时器并保存未写入的数据 */
  close(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.dirty) {
      this.dirty = false;
      try {
        const data = [...this.tracks.values()];
        writeFileSync(join(this.storagePath, TRACKS_META_FILE), JSON.stringify(data));
      } catch (err) {
        console.warn("[TrackStorage] close 时保存失败:", err instanceof Error ? err.message : String(err));
        this.dirty = true;
      }
    }
  }

  /** 从磁盘加载 */
  private async loadFromDisk(): Promise<void> {
    const metaPath = join(this.storagePath, TRACKS_META_FILE);
    try {
      const raw = JSON.parse(await readFile(metaPath, "utf-8")) as TrackRecord[];
      for (const r of raw) {
        if (r.bestSnapshotScore === undefined) r.bestSnapshotScore = 0;
        this.tracks.set(r.trackId, r);
      }
    } catch {
      /* 文件不存在或格式错误，从空数据开始 */
    }
  }
}
