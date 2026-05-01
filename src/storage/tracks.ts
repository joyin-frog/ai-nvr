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
  /** 主色调名称（从 HSV 直方图提取，如 "red", "blue", "green"） */
  dominantColor?: string;
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
          /** 更新 dHash 和颜色直方图 */
          existingRecord.dhash = await this.computeDHash(frameImage, box);
          existingRecord.colorHist = await this.computeColorHist(frameImage, box);
          existingRecord.lbpHist = await this.computeLBP(frameImage, box);
        }
      }
      this.scheduleSave();
      return;
    }

    /** 新目标：裁剪快照并保存 */
    const snapshotFile = await this.cropAndSave(trackId, cameraId, frameImage, box);
    /** 计算 dHash 和颜色直方图 */
    const dhash = box ? await this.computeDHash(frameImage, box) : undefined;
    const colorHist = box ? await this.computeColorHist(frameImage, box) : undefined;
    const lbpHist = box ? await this.computeLBP(frameImage, box) : undefined;

    const newRecord: TrackRecord = {
      trackId,
      label,
      firstSeen: timestamp,
      lastSeen: timestamp,
      hitCount: 1,
      cameraIds: [cameraId],
      snapshotFile,
      bestSnapshotScore: snapshotScore,
      dhash,
      colorHist,
      lbpHist,
    };
    this.tracks.set(trackId, newRecord);
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
      dominantColor: r.colorHist ? TrackStorage.extractDominantColor(r.colorHist) : undefined,
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

  /**
   * 批量获取未命名目标的匹配建议
   * 对每个未命名且有 dhash 的目标，查找同标签已命名目标中最相似的
   * 使用多快照指纹匹配（主指纹 + 备选指纹取最优距离）
   */
  getSuggestions(): Array<{ trackId: number; label: string; suggestedName: string; distance: number }> {
    /** 收集所有已命名目标（有 dhash） */
    const named: TrackRecord[] = [];
    for (const r of this.tracks.values()) {
      if (r.customName && r.dhash) named.push(r);
    }
    if (named.length === 0) return [];

    const results: Array<{ trackId: number; label: string; suggestedName: string; distance: number }> = [];
    for (const r of this.tracks.values()) {
      if (r.customName || !r.dhash) continue;
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
      if (existsSync(path)) unlinkSync(path);
    }
    this.tracks.delete(trackId);
    this.scheduleSave();
    return true;
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
   * 计算 HSV 颜色直方图
   * H=8 bins, S=4 bins, V=4 bins = 128 维
   * 归一化后量化为 0-255 的 uint8 数组
   */
  async computeColorHist(frameImage: Buffer, box: Detection["box"]): Promise<number[]> {
    if (!box) return [];
    const image = sharp(frameImage);
    const meta = await image.metadata();
    if (!meta.width || !meta.height) return [];

    const padW = (box.xmax - box.xmin) * 0.2;
    const padH = (box.ymax - box.ymin) * 0.2;
    const left = Math.max(0, Math.floor((box.xmin - padW) * meta.width));
    const top = Math.max(0, Math.floor((box.ymin - padH) * meta.height));
    const width = Math.min(meta.width - left, Math.ceil((box.xmax - box.xmin + padW * 2) * meta.width));
    const height = Math.min(meta.height - top, Math.ceil((box.ymax - box.ymin + padH * 2) * meta.height));

    if (width < 10 || height < 10) return [];

    /** 缩小到 32x32 减少计算量 */
    const { data, info } = await image
      .extract({ left, top, width, height })
      .resize(32, 32, { fit: "fill" })
      .raw()
      .toBuffer({ resolveWithObject: true });

    /** H=8, S=4, V=4 → 128 bins */
    const bins = new Float64Array(128);
    let totalPixels = 0;

    for (let i = 0; i < data.length; i += info.channels) {
      const r = data[i]! / 255;
      const g = data[i + 1]! / 255;
      const b = data[i + 2]! / 255;

      /** RGB → HSV */
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const d = max - min;
      /** 明度 V */
      const v = max;
      /** 饱和度 S */
      const s = max === 0 ? 0 : d / max;
      /** 色相 H */
      let h = 0;
      if (d !== 0) {
        if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        else if (max === g) h = ((b - r) / d + 2) / 6;
        else h = ((r - g) / d + 4) / 6;
      }

      /** 量化到 bins */
      const hBin = Math.min(7, Math.floor(h * 8));
      const sBin = Math.min(3, Math.floor(s * 4));
      const vBin = Math.min(3, Math.floor(v * 4));
      /** 组合索引: hBin * 16 + sBin * 4 + vBin */
      const idx = hBin * 16 + sBin * 4 + vBin;
      bins[idx]!++;
      totalPixels++;
    }

    if (totalPixels === 0) return [];

    /** 归一化并量化到 0-255 */
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
    /** 归一化：卡方距离的最大值约为 2（完全不同的分布） */
    return Math.min(1, chiSq / 2);
  }

  /**
   * 计算 LBP（Local Binary Pattern）纹理直方图
   * 使用 uniform 模式（59 bins: 0-57 为 uniform 模式，58 为所有非 uniform 模式）
   * 对光照变化鲁棒，能有效区分不同纹理（如衣物花纹）
   */
  async computeLBP(frameImage: Buffer, box: Detection["box"]): Promise<number[]> {
    if (!box) return [];
    const image = sharp(frameImage);
    const meta = await image.metadata();
    if (!meta.width || !meta.height) return [];

    const padW = (box.xmax - box.xmin) * 0.2;
    const padH = (box.ymax - box.ymin) * 0.2;
    const left = Math.max(0, Math.floor((box.xmin - padW) * meta.width));
    const top = Math.max(0, Math.floor((box.ymin - padH) * meta.height));
    const width = Math.min(meta.width - left, Math.ceil((box.xmax - box.xmin + padW * 2) * meta.width));
    const height = Math.min(meta.height - top, Math.ceil((box.ymax - box.ymin + padH * 2) * meta.height));

    if (width < 10 || height < 10) return [];

    /** 缩小到 32x32 减少计算量 */
    const { data, info } = await image
      .extract({ left, top, width, height })
      .resize(32, 32, { fit: "fill" })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    /** LBP uniform 模式表：8 邻域最多 58 种 uniform 模式 */
    const HIST_BINS = 59;
    const bins = new Float64Array(HIST_BINS);
    let totalPixels = 0;

    for (let y = 1; y < info.height - 1; y++) {
      for (let x = 1; x < info.width - 1; x++) {
        const center = data[y * info.width + x]!;
        /** 8 邻域顺时针从右上角开始 */
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

        /** 计算 LBP 值 */
        let lbpVal = 0;
        for (let i = 0; i < 8; i++) {
          if (neighbors[i]! >= center) lbpVal |= (1 << i);
        }

        /** 映射到 uniform 模式 */
        const bin = TrackStorage.lbpToUniform(lbpVal);
        bins[bin]!++;
        totalPixels++;
      }
    }

    if (totalPixels === 0) return [];

    /** 归一化并量化到 0-255 */
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
   */
  static computeBestDistance(
    recA: { dhash?: string; colorHist?: number[]; lbpHist?: number[]; altFingerprints?: AltFingerprint[] },
    recB: { dhash?: string; colorHist?: number[]; lbpHist?: number[]; altFingerprints?: AltFingerprint[] },
  ): number {
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
   * 综合使用 dHash（结构）+ 颜色直方图（颜色）+ LBP（纹理）
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
  ): Array<{ trackId: number; customName: string; distance: number }> {
    if (!dhash) return [];

    /** 当前查询目标的完整指纹 */
    const queryRec = { dhash, colorHist, lbpHist };

    /** 同标签匹配结果 + 跨标签匹配结果 */
    const sameLabel: Array<{ trackId: number; customName: string; distance: number }> = [];
    const crossLabel: Array<{ trackId: number; customName: string; distance: number }> = [];

    for (const record of this.tracks.values()) {
      if (record.trackId === trackId) continue;
      if (!record.customName || !record.dhash) continue;

      /** 使用最优距离（主指纹 + 备选指纹） */
      const combinedDist = TrackStorage.computeBestDistance(queryRec, record);

      if (record.label === label) {
        if (combinedDist <= maxDistance) {
          sameLabel.push({ trackId: record.trackId, customName: record.customName, distance: combinedDist });
        }
      } else {
        if (combinedDist <= maxDistance * 1.2) {
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
