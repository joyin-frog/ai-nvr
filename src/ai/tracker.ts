import { type Detection } from "./types";

/** 追踪目标 */
export interface TrackedObject {
  /** 追踪 ID（全局递增） */
  trackId: number;
  /** 检测标签 */
  label: string;
  /** 置信度 */
  score: number;
  /** 边界框（归一化坐标 0-1） */
  box: { xmin: number; ymin: number; xmax: number; ymax: number };
  /** 连续追踪帧数 */
  age: number;
  /** 上次匹配到的帧 */
  lastMatched: number;
}

/** 追踪结果（带 trackId 的检测结果） */
export interface TrackedDetection extends Detection {
  trackId: number;
}

/** 追踪更新结果 */
export interface TrackUpdateResult {
  /** 带追踪 ID 的检测结果 */
  detections: TrackedDetection[];
  /** 新出现的追踪 ID */
  appeared: Array<{ trackId: number; label: string; score: number; box: TrackedObject["box"] }>;
  /** 消失的追踪 ID（丢失超过阈值） */
  disappeared: Array<{ trackId: number; label: string }>;
}

let nextTrackId = 1;

/**
 * ByteTrack 风格的目标追踪器
 * 基于 IoU 匹配，将每帧检测结果关联到上一帧的追踪目标
 *
 * 算法：
 * 1. 用匈牙利算法做 IoU 匹配（高分检测 → 高分追踪）
 * 2. 未匹配的高分检测 → 新建追踪
 * 3. 未匹配的追踪 → 保留 maxLost 帧
 * 4. 低分检测不参与匹配（减少误检干扰）
 */
export class ObjectTracker {
  /** 当前活跃的追踪目标 */
  private tracks: TrackedObject[] = [];
  /** 最大丢失帧数 */
  private maxLost: number;
  /** IoU 匹配阈值 */
  private iouThreshold: number;
  /** 新建追踪的置信度阈值 */
  private newTrackThreshold: number;
  /** 当前帧序号 */
  private frameIndex = 0;

  constructor(options?: {
    maxLost?: number;
    iouThreshold?: number;
    newTrackThreshold?: number;
  }) {
    this.maxLost = options?.maxLost ?? 5;
    this.iouThreshold = options?.iouThreshold ?? 0.3;
    this.newTrackThreshold = options?.newTrackThreshold ?? 0.5;
  }

  /**
   * 更新追踪器，输入新帧的检测结果
   * 返回带 trackId 的检测结果和语义事件
   */
  update(detections: Detection[]): TrackUpdateResult {
    this.frameIndex++;

    const appeared: TrackUpdateResult["appeared"] = [];
    const disappeared: TrackUpdateResult["disappeared"] = [];
    const results: TrackedDetection[] = [];

    /** 分离高/低置信度检测 */
    const highDets = detections.filter(d => d.score >= this.newTrackThreshold);

    /** 记录清理前的活跃追踪（用于检测消失） */
    const prevActiveIds = new Set(
      this.tracks.filter(t => this.frameIndex - t.lastMatched <= 2).map(t => t.trackId),
    );

    /** 第一帧：全部创建新追踪 */
    if (this.tracks.length === 0) {
      for (const det of highDets) {
        const track: TrackedObject = {
          trackId: nextTrackId++,
          label: det.label,
          score: det.score,
          box: { ...det.box },
          age: 1,
          lastMatched: this.frameIndex,
        };
        this.tracks.push(track);
        results.push({ ...det, trackId: track.trackId });
        appeared.push({ trackId: track.trackId, label: track.label, score: track.score, box: track.box });
      }
      return { detections: results, appeared, disappeared };
    }

    /** 计算 IoU 矩阵：tracks × detections */
    const costMatrix = this.buildCostMatrix(this.tracks, highDets);

    /** 匈牙利匹配（贪心近似，足够快） */
    const { matchedTracks, unmatchedTracks, unmatchedDets } = this.greedyMatch(
      costMatrix,
      this.tracks.length,
      highDets.length,
    );

    /** 更新匹配到的追踪 */
    for (const [ti, di] of matchedTracks) {
      const track = this.tracks[ti]!;
      const det = highDets[di]!;
      track.box = { ...det.box };
      track.score = det.score;
      track.label = det.label;
      track.age++;
      track.lastMatched = this.frameIndex;
      results.push({ ...det, trackId: track.trackId });
    }

    /** 未匹配的检测 → 新建追踪 */
    for (const di of unmatchedDets) {
      const det = highDets[di]!;
      const track: TrackedObject = {
        trackId: nextTrackId++,
        label: det.label,
        score: det.score,
        box: { ...det.box },
        age: 1,
        lastMatched: this.frameIndex,
      };
      this.tracks.push(track);
      results.push({ ...det, trackId: track.trackId });
      appeared.push({ trackId: track.trackId, label: track.label, score: track.score, box: track.box });
    }

    /** 清理丢失太久的追踪，记录消失的目标 */
    this.tracks = this.tracks.filter(t => {
      const lost = this.frameIndex - t.lastMatched;
      if (lost > this.maxLost) {
        /** 只记录之前活跃的追踪消失 */
        if (prevActiveIds.has(t.trackId)) {
          disappeared.push({ trackId: t.trackId, label: t.label });
        }
        return false;
      }
      return true;
    });

    return { detections: results, appeared, disappeared };
  }

  /** 获取当前活跃的追踪目标 */
  getActiveTracks(): TrackedObject[] {
    return this.tracks.filter(t => this.frameIndex - t.lastMatched <= 1);
  }

  /** 重置追踪器 */
  reset(): void {
    this.tracks = [];
    this.frameIndex = 0;
  }

  /** 构建 IoU 代价矩阵（负 IoU，因为贪心算法求最小代价） */
  private buildCostMatrix(tracks: TrackedObject[], dets: Detection[]): number[][] {
    const matrix: number[][] = [];
    for (let i = 0; i < tracks.length; i++) {
      matrix[i] = [];
      for (let j = 0; j < dets.length; j++) {
        const iou = this.computeIou(tracks[i]!.box, dets[j]!.box);
        /** 只匹配同标签 */
        if (tracks[i]!.label !== dets[j]!.label) {
          matrix[i]![j] = 1;
        } else {
          matrix[i]![j] = 1 - iou;
        }
      }
    }
    return matrix;
  }

  /** 贪心匹配：每轮选最小代价的配对 */
  private greedyMatch(
    costMatrix: number[][],
    numTracks: number,
    numDets: number,
  ): {
    matchedTracks: Array<[number, number]>;
    unmatchedTracks: number[];
    unmatchedDets: number[];
  } {
    const matchedTracks: Array<[number, number]> = [];
    const usedTracks = new Set<number>();
    const usedDets = new Set<number>();

    /** 收集所有候选配对并按代价排序 */
    const candidates: Array<{ cost: number; ti: number; di: number }> = [];
    for (let i = 0; i < numTracks; i++) {
      for (let j = 0; j < numDets; j++) {
        const cost = costMatrix[i]?.[j] ?? 1;
        if (cost < 1 - this.iouThreshold) {
          candidates.push({ cost, ti: i, di: j });
        }
      }
    }
    candidates.sort((a, b) => a.cost - b.cost);

    /** 贪心选取 */
    for (const { cost, ti, di } of candidates) {
      if (usedTracks.has(ti) || usedDets.has(di)) continue;
      matchedTracks.push([ti, di]);
      usedTracks.add(ti);
      usedDets.add(di);
    }

    const unmatchedTracks = Array.from({ length: numTracks }, (_, i) => i)
      .filter(i => !usedTracks.has(i));
    const unmatchedDets = Array.from({ length: numDets }, (_, i) => i)
      .filter(i => !usedDets.has(i));

    return { matchedTracks, unmatchedTracks, unmatchedDets };
  }

  /** 计算两个 bbox 的 IoU */
  private computeIou(
    a: { xmin: number; ymin: number; xmax: number; ymax: number },
    b: { xmin: number; ymin: number; xmax: number; ymax: number },
  ): number {
    const x1 = Math.max(a.xmin, b.xmin);
    const y1 = Math.max(a.ymin, b.ymin);
    const x2 = Math.min(a.xmax, b.xmax);
    const y2 = Math.min(a.ymax, b.ymax);

    const interArea = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    if (interArea === 0) return 0;

    const aArea = (a.xmax - a.xmin) * (a.ymax - a.ymin);
    const bArea = (b.xmax - b.xmin) * (b.ymax - b.ymin);
    return interArea / (aArea + bArea - interArea);
  }
}
