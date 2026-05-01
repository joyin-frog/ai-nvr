import { type Detection } from "./types";

/** 追踪目标 */
export interface TrackedObject {
  /** 追踪 ID（全局递增） */
  trackId: number;
  /** 检测标签 */
  label: string;
  /** 置信度 */
  score: number;
  /** 平滑后的边界框（用于输出） */
  box: { xmin: number; ymin: number; xmax: number; ymax: number };
  /** 上一次匹配的原始检测框（用于下一帧 IoU 匹配） */
  rawBox: { xmin: number; ymin: number; xmax: number; ymax: number };
  /** 线性运动预测框（基于速度外推） */
  predictedBox: { xmin: number; ymin: number; xmax: number; ymax: number };
  /** 速度向量（dx, dy per frame），用于运动预测 */
  velocity: { dx: number; dy: number };
  /** 连续追踪帧数 */
  age: number;
  /** 上次匹配到的帧 */
  lastMatched: number;
  /** 标签投票计数 */
  labelVotes: Map<string, number>;
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
    this.maxLost = options?.maxLost ?? 15;
    this.iouThreshold = options?.iouThreshold ?? 0.2;
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
        const votes = new Map<string, number>();
        votes.set(det.label, 1);
        const track: TrackedObject = {
          trackId: nextTrackId++,
          label: det.label,
          score: det.score,
          box: { ...det.box },
          rawBox: { ...det.box },
          predictedBox: { ...det.box },
          velocity: { dx: 0, dy: 0 },
          age: 1,
          lastMatched: this.frameIndex,
          labelVotes: votes,
        };
        this.tracks.push(track);
        results.push({ ...det, trackId: track.trackId });
      }
      return { detections: results, appeared, disappeared };
    }

    /** 未匹配追踪的运动预测外推：按速度继续推进 predictedBox */
    for (const track of this.tracks) {
      const lost = this.frameIndex - track.lastMatched;
      if (lost > 0 && (track.velocity.dx !== 0 || track.velocity.dy !== 0)) {
        track.predictedBox = {
          xmin: track.predictedBox.xmin + track.velocity.dx,
          ymin: track.predictedBox.ymin + track.velocity.dy,
          xmax: track.predictedBox.xmax + track.velocity.dx,
          ymax: track.predictedBox.ymax + track.velocity.dy,
        };
      }
    }

    /** 计算 IoU 矩阵：用 predictedBox（运动预测位置）匹配 */
    const costMatrix = this.buildCostMatrix(this.tracks, highDets);

    /** 匈牙利匹配（贪心近似，足够快） */
    const { matchedTracks, unmatchedDets } = this.greedyMatch(
      costMatrix,
      this.tracks.length,
      highDets.length,
    );

    /** EMA 平滑系数（0.5 = 50% 新值 + 50% 旧值，跟随更快） */
    const smoothAlpha = 0.5;

    /** 更新匹配到的追踪（框位置 EMA 平滑 + 速度更新 + 运动预测） */
    for (const [ti, di] of matchedTracks) {
      const track = this.tracks[ti]!;
      const det = highDets[di]!;
      /** 速度 = 新位置 - 旧位置 */
      const dx = det.box.xmin - track.rawBox.xmin;
      const dy = det.box.ymin - track.rawBox.ymin;
      /** 先更新 rawBox 为当前检测位置 */
      track.rawBox = { ...det.box };
      /** 更新速度（EMA 平滑，减少抖动） */
      track.velocity = {
        dx: track.velocity.dx * 0.5 + dx * 0.5,
        dy: track.velocity.dy * 0.5 + dy * 0.5,
      };
      /** 预测下一帧位置 = 当前位置 + 平滑速度 */
      track.predictedBox = {
        xmin: det.box.xmin + track.velocity.dx,
        ymin: det.box.ymin + track.velocity.dy,
        xmax: det.box.xmax + track.velocity.dx,
        ymax: det.box.ymax + track.velocity.dy,
      };
      /** box 做平滑用于显示 */
      const prev = track.box;
      const curr = det.box;
      track.box = {
        xmin: prev.xmin + smoothAlpha * (curr.xmin - prev.xmin),
        ymin: prev.ymin + smoothAlpha * (curr.ymin - prev.ymin),
        xmax: prev.xmax + smoothAlpha * (curr.xmax - prev.xmax),
        ymax: prev.ymax + smoothAlpha * (curr.ymax - prev.ymax),
      };
      track.score = det.score;
      /** 标签投票：只有新标签累计超过旧标签时才切换 */
      track.labelVotes.set(det.label, (track.labelVotes.get(det.label) ?? 0) + 1);
      let bestLabel = track.label;
      let bestCount = track.labelVotes.get(track.label) ?? 0;
      for (const [lbl, count] of track.labelVotes) {
        if (count > bestCount) {
          bestLabel = lbl;
          bestCount = count;
        }
      }
      track.label = bestLabel;
      track.age++;
      track.lastMatched = this.frameIndex;
      results.push({ label: track.label, score: track.score, box: { ...track.box }, trackId: track.trackId });
    }

    /** 未匹配的检测 → 新建追踪 */
    for (const di of unmatchedDets) {
      const det = highDets[di]!;
      const votes = new Map<string, number>();
      votes.set(det.label, 1);
      const track: TrackedObject = {
        trackId: nextTrackId++,
        label: det.label,
        score: det.score,
        box: { ...det.box },
        rawBox: { ...det.box },
        predictedBox: { ...det.box },
        velocity: { dx: 0, dy: 0 },
        age: 1,
        lastMatched: this.frameIndex,
        labelVotes: votes,
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

  /** 构建 IoU 代价矩阵（用 predictedBox 匹配，运动预测补偿快速移动目标） */
  private buildCostMatrix(tracks: TrackedObject[], dets: Detection[]): number[][] {
    const matrix: number[][] = [];
    for (let i = 0; i < tracks.length; i++) {
      matrix[i] = [];
      for (let j = 0; j < dets.length; j++) {
        const iou = this.computeIou(tracks[i]!.predictedBox, dets[j]!.box);
        /** 同标签优先匹配，不同标签加惩罚 */
        const labelPenalty = tracks[i]!.label !== dets[j]!.label ? 0.3 : 0;
        matrix[i]![j] = 1 - iou + labelPenalty;
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
    for (const { ti, di } of candidates) {
      if (usedTracks.has(ti) || usedDets.has(di)) continue;
      matchedTracks.push([ti, di]);
      usedTracks.add(ti);
      usedDets.add(di);
    }

    const unmatchedDets = Array.from({ length: numDets }, (_, i) => i)
      .filter(i => !usedDets.has(i));

    return { matchedTracks, unmatchedDets };
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
