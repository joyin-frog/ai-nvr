/**
 * AI 性能指标收集器
 * 全局单例，被各 AI 模块共享，记录推理延迟、吞吐量、置信度分布等
 */

/** 单次推理记录 */
interface InferenceRecord {
  /** 模块来源 (detector | patrol | scene | summary | rule | track-activity | recording) */
  source: string;
  /** 推理耗时 ms */
  inferMs: number;
  /** 时间戳 */
  ts: number;
  /** 是否成功 */
  ok: boolean;
  /** 检测目标数量（仅 detector） */
  objectCount?: number;
  /** 平均置信度（仅 detector） */
  avgConfidence?: number;
}

/** 模块级指标快照 */
export interface ModuleMetrics {
  /** 模块名 */
  source: string;
  /** 最近 5 分钟调用次数 */
  calls5m: number;
  /** 最近 5 分钟成功次数 */
  ok5m: number;
  /** 最近 5 分钟平均延迟 ms */
  avgMs5m: number;
  /** 最近 5 分钟 P95 延迟 ms */
  p95Ms5m: number;
  /** 最近 5 分钟错误率 */
  errorRate5m: number;
}

/** 全局 AI 指标快照 */
export interface AiMetricsSnapshot {
  /** 各模块指标 */
  modules: ModuleMetrics[];
  /** 最近 5 分钟总推理次数 */
  totalCalls5m: number;
  /** 最近 5 分钟总成功次数 */
  totalOk5m: number;
  /** 最近 5 分钟平均延迟 */
  avgMs5m: number;
  /** 置信度分布（仅 detector，10 个桶：0-0.1, 0.1-0.2, ... 0.9-1.0） */
  confidenceBuckets: number[];
  /** 最近 5 分钟检测目标总数 */
  totalObjects5m: number;
  /** VLM 并发使用情况 */
  vlmConcurrency: number;
  /** VLM 最大并发 */
  vlmMaxConcurrency: number;
}

class AiMetricsCollector {
  /** 环形缓冲区存储最近 5 分钟的推理记录 */
  private records: InferenceRecord[] = [];
  /** 最大保留条目数（约 5 分钟 × 每秒 1 次 × 60 = 300） */
  private static readonly MAX_RECORDS = 600;

  /** 记录一次推理 */
  record(entry: Omit<InferenceRecord, "ts">): void {
    this.records.push({ ...entry, ts: Date.now() });
    if (this.records.length > AiMetricsCollector.MAX_RECORDS) {
      this.records = this.records.slice(-AiMetricsCollector.MAX_RECORDS);
    }
  }

  /** 生成全局指标快照 */
  snapshot(vlmConcurrency: number, vlmMaxConcurrency: number): AiMetricsSnapshot {
    const cutoff = Date.now() - 300_000;
    const recent = this.records.filter(r => r.ts >= cutoff);

    /** 按模块分组 */
    const sourceGroups = new Map<string, InferenceRecord[]>();
    for (const r of recent) {
      const group = sourceGroups.get(r.source);
      if (group) group.push(r);
      else sourceGroups.set(r.source, [r]);
    }

    const modules: ModuleMetrics[] = [];
    for (const [source, group] of sourceGroups) {
      const latencies = group.filter(r => r.ok).map(r => r.inferMs).sort((a, b) => a - b);
      const okCount = latencies.length;
      const p95Idx = Math.floor(latencies.length * 0.95);
      modules.push({
        source,
        calls5m: group.length,
        ok5m: okCount,
        avgMs5m: okCount > 0 ? Math.round(latencies.reduce((s, v) => s + v, 0) / okCount) : 0,
        p95Ms5m: okCount > 0 ? (latencies[p95Idx] ?? latencies[latencies.length - 1] ?? 0) : 0,
        errorRate5m: group.length > 0 ? Math.round((group.length - okCount) / group.length * 100) : 0,
      });
    }

    /** 置信度分布（仅 detector） */
    const confidenceBuckets = new Array(10).fill(0);
    let totalObjects = 0;
    for (const r of recent) {
      if (r.source === "detector" && r.objectCount !== undefined) {
        totalObjects += r.objectCount;
        if (r.avgConfidence !== undefined) {
          const bucket = Math.min(9, Math.floor(r.avgConfidence * 10));
          confidenceBuckets[bucket]!++;
        }
      }
    }

    const allOk = recent.filter(r => r.ok);
    const allLatencies = allOk.map(r => r.inferMs);

    return {
      modules,
      totalCalls5m: recent.length,
      totalOk5m: allOk.length,
      avgMs5m: allLatencies.length > 0 ? Math.round(allLatencies.reduce((s, v) => s + v, 0) / allLatencies.length) : 0,
      confidenceBuckets,
      totalObjects5m: totalObjects,
      vlmConcurrency,
      vlmMaxConcurrency,
    };
  }
}

/** 全局 AI 指标收集器实例 */
export const aiMetrics = new AiMetricsCollector();
