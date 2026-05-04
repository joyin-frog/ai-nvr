import { type Observer, type ObservationResult, type ObservationEvent, type PreparedFrames } from "@/observer/types";
import { type SignalStore, type Signal } from "@/signal/store";
import { type ObserverStorage } from "@/observer/storage";
import { type RoiStorage } from "@/storage/roi";
import { type EventBus } from "@/event-bus";
import { aiMetrics } from "@/ai/metrics";

/** 信号上下文信息（注入 prompt 用） */
export interface SignalContext {
  id: number;
  name: string;
  description: string;
  valueType: string;
  currentValue: string;
}

/** 结果处理器依赖 */
export interface ResultProcessorDeps {
  eventBus: EventBus;
  storage: ObserverStorage;
  signalStore?: SignalStore;
  roiStorage?: RoiStorage;
  saveSnapshot?: (cameraId: string, timestamp: number, jpeg: Buffer) => void;
}

/**
 * 结果处理模块
 * 负责：记录写入、信号更新、事件发射、快照保存、近匹配趋势检测
 */
export class ResultProcessor {
  /** 近匹配趋势：最近一次近匹配的置信度 */
  private nearMatchLastConf = new Map<number, number>();
  /** 近匹配趋势：连续上升次数 */
  private nearMatchRiseCount = new Map<number, number>();
  /** 近匹配趋势：上次趋势告警时间 */
  private nearMatchLastAlert = new Map<number, number>();
  /** 信号缓存 */
  private signalsCache: Signal[] = [];
  private signalsCacheTime = 0;
  private static readonly CACHE_TTL = 30_000;
  /** 快照保存回调 */
  private saveSnapshotFn?: (cameraId: string, timestamp: number, jpeg: Buffer) => void;

  constructor(private deps: ResultProcessorDeps) {
    this.saveSnapshotFn = deps.saveSnapshot;
  }

  /** 设置快照保存回调 */
  setSaveSnapshot(fn: (cameraId: string, timestamp: number, jpeg: Buffer) => void): void {
    this.saveSnapshotFn = fn;
  }

  /** 获取缓存的信号上下文（用于 prompt 注入） */
  getSignalContexts(): SignalContext[] {
    if (!this.deps.signalStore) return [];
    const now = Date.now();
    if (now - this.signalsCacheTime < ResultProcessor.CACHE_TTL) {
      return this.signalsCache.map(s => ({
        id: s.id, name: s.name, description: s.description,
        valueType: s.valueType, currentValue: s.currentValue,
      }));
    }
    this.signalsCache = this.deps.signalStore.listSignals();
    this.signalsCacheTime = now;
    return this.signalsCache.map(s => ({
      id: s.id, name: s.name, description: s.description,
      valueType: s.valueType, currentValue: s.currentValue,
    }));
  }

  /**
   * 处理 VLM 分析结果
   */
  process(
    result: ObservationResult,
    obs: Observer,
    frames: PreparedFrames,
    timestamp: number,
    rawResponse: string,
    inferMs: number,
  ): void {
    aiMetrics.record({ source: "rule", inferMs, ok: true, avgConfidence: result.confidence });

    /** 写入记录 */
    this.deps.storage.insertRecord(
      obs.id, obs.name, obs.cameras[0]?.cameraId ?? "", timestamp,
      result.description, result.matched,
      JSON.stringify({
        confidence: result.confidence,
        prompt: obs.prompt,
        rawResponse,
        regions: result.regions,
        signalIds: obs.signalIds,
        signalUpdates: result.signalUpdates,
        cameras: obs.cameras.map(c => this.snapshotCameraSource(c)),
      }),
    );

    /** 近匹配趋势检测 */
    if (!result.matched && result.confidence >= 0.5) {
      this.checkNearMatchTrend(obs, timestamp, result.confidence, result.description);
    }

    /** 信号更新 */
    this.updateSignals(result, obs, timestamp);

    /** 保存快照（无论是否匹配，便于调试） */
    this.saveSnapshots(obs, frames, timestamp);

    /** 匹配成功：发出事件 */
    if (result.matched) {
      this.emitObservationEvent(result, obs, frames, timestamp, rawResponse);
      console.log(`[Observer] "${obs.name}" 匹配 (${(result.confidence * 100).toFixed(0)}%): ${result.description.slice(0, 80)}`);
    }
  }

  /** 更新信号值 */
  private updateSignals(result: ObservationResult, obs: Observer, timestamp: number): void {
    if (!result.signalUpdates || !this.deps.signalStore) return;

    for (const update of result.signalUpdates) {
      const signalDef = this.deps.signalStore.getSignal(update.id);
      if (!signalDef?.enabled) continue;

      const change = this.deps.signalStore.setValue(update.id, update.value, `observer:${obs.id}`, obs.id);
      if (change) {
        this.deps.eventBus.emit("signal:changed", {
          signalId: change.signalId,
          signalName: change.signalName,
          cameraId: change.cameraId,
          oldValue: change.oldValue,
          newValue: change.newValue,
          source: change.source,
          sourceId: change.sourceId,
          timestamp: change.timestamp,
          notify: signalDef.notifyOnChange,
        });
      }
    }
  }

  /** 保存快照（原图 + ROI 裁剪后的处理图） */
  private saveSnapshots(obs: Observer, frames: PreparedFrames, timestamp: number): void {
    if (!this.saveSnapshotFn) return;

    for (const [camId, camData] of frames.cameraFrames) {
      /** 原图 */
      this.saveSnapshotFn(camId, timestamp, camData.original);
      /** ROI 裁剪后的图：仅当该摄像头源配了 ROI 时才保存 */
      const camSrc = obs.cameras.find(c => c.cameraId === camId);
      if (camSrc && camSrc.roiId > 0) {
        this.saveSnapshotFn(`${camId}_roi`, timestamp, camData.processed);
      }
    }

    /** 回退：无帧数据时跳过快照保存 */
    if (frames.cameraFrames.size === 0) {
      const fallbackCameraId = obs.cameras[0]?.cameraId ?? "";
      if (fallbackCameraId) {
        console.warn(`[ResultProcessor] ${fallbackCameraId} 无可用帧，跳过快照保存`);
      }
    }
  }

  /** 发出观测事件 */
  private emitObservationEvent(result: ObservationResult, obs: Observer, frames: PreparedFrames, timestamp: number, rawResponse: string): void {
    const snapshotCameras = Array.from(frames.cameraFrames.keys()).map(camId => ({ cameraId: camId, timestamp }));
    const detail = JSON.stringify({ confidence: result.confidence, prompt: obs.prompt, rawResponse, regions: result.regions, snapshotCameras });

    const event: ObservationEvent = {
      observerId: obs.id,
      observerName: obs.name,
      cameraId: obs.cameras[0]?.cameraId ?? "",
      timestamp,
      prompt: obs.prompt,
      result: result.description,
      confidence: result.confidence,
      detail,
      regions: result.regions,
    };

    /** 同时发出新旧事件名，确保兼容 */
    this.deps.eventBus.emit("observation", event as never);
  }

  /** 快照摄像头源配置（包含 ROI 坐标快照，避免后续修改影响历史数据） */
  private snapshotCameraSource(c: { cameraId: string; roiId: number }): { cameraId: string; roiId: number; roiPoints?: Array<{ x: number; y: number }> } {
    if (c.roiId <= 0 || !this.deps.roiStorage) return { cameraId: c.cameraId, roiId: c.roiId };
    const roi = this.deps.roiStorage.getById(c.roiId);
    if (!roi?.points) return { cameraId: c.cameraId, roiId: c.roiId };
    let points: Array<{ x: number; y: number }> = [];
    try { points = JSON.parse(roi.points); } catch { /* ignore */ }
    return { cameraId: c.cameraId, roiId: c.roiId, roiPoints: points };
  }

  /** 近匹配趋势检测 */
  private checkNearMatchTrend(obs: Observer, timestamp: number, confidence: number, description: string): void {
    const lastConf = this.nearMatchLastConf.get(obs.id) ?? 0;
    const rising = confidence > lastConf;
    const count = this.nearMatchRiseCount.get(obs.id) ?? 0;
    const newCount = rising ? count + 1 : 0;
    this.nearMatchLastConf.set(obs.id, confidence);
    this.nearMatchRiseCount.set(obs.id, newCount);

    const lastAlert = this.nearMatchLastAlert.get(obs.id) ?? 0;
    if (newCount >= 3 && confidence >= 0.6 && timestamp - lastAlert > 300_000) {
      this.nearMatchLastAlert.set(obs.id, timestamp);
      const trendEvent: ObservationEvent = {
        observerId: obs.id,
        observerName: `${obs.name} (趋势)`,
        cameraId: obs.cameras[0]?.cameraId ?? "",
        timestamp,
        prompt: obs.prompt,
        result: `置信度持续上升: ${(lastConf * 100).toFixed(0)}% → ${(confidence * 100).toFixed(0)}% (${newCount}次连续上升)。${description}`,
        confidence,
        detail: JSON.stringify({ confidence, trend: true }),
      };
      this.deps.eventBus.emit("observation", trendEvent as never);
      console.log(`[Observer] "${obs.name}" 近匹配趋势: ${newCount}次上升, 置信度 ${(confidence * 100).toFixed(0)}%`);
    }
  }

  /** 清除缓存 */
  clearCaches(): void {
    this.signalsCache = [];
    this.signalsCacheTime = 0;
  }
}
