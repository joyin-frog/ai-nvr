import { Worker } from "node:worker_threads";
import { ensureModelCached } from "./model-downloader";
import { ObjectTracker, initNextTrackId } from "./tracker";

/** 设置模型下载源（HF_ENDPOINT 仅对 Python SDK 生效，JS 库需设置 env.remoteHost） */
const hfEndpoint = process.env.HF_ENDPOINT ?? "https://huggingface.co";

/** 模型加载最大重试次数 */
const MAX_RETRIES = 3;
/** 重试基础延迟（毫秒） */
const RETRY_BASE_DELAY = 5000;
import { type Detection, type DetectMode } from "./types";
import { type Annotator } from "./annotator";
import { type EventBus } from "@/event-bus";
import { type RuntimeConfig } from "@/runtime-config";
import { TrackStorage } from "@/storage/tracks";
import { type TrackLabelStorage } from "@/storage/track-labels";
import { type TrackTrajectoryStorage } from "@/storage/track-trajectory";
import { ClipService } from "./clip-service";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Worker 推理请求 ID */
let requestId = 0;
/** 等待中的推理请求 */
const pendingRequests = new Map<number, {
  resolve: (result: WorkerDetectResult) => void;
  cameraId: string;
  jpeg: Buffer;
  timestamp: number;
}>();

/** Worker 推理结果类型 */
interface WorkerDetectResult {
  id: number;
  cameraId: string;
  timestamp: number;
  detections: Array<{
    label: string;
    score: number;
    box: { xmin: number; ymin: number; xmax: number; ymax: number };
  }>;
  /** 图像嵌入向量（CLIP） */
  embedding: number[];
  fingerprint: string;
  inferMs: number;
  resizeMs: number;
  error?: string;
}

/**
 * AI 目标检测器
 * 推理在 Worker 线程执行，不阻塞主线程 HTTP 服务
 */
export class AiDetector {
  /** Worker 线程 */
  private worker: Worker | null = null;
  /** 是否已初始化 */
  private initialized = false;
  /** 当前加载的模型名称 */
  private currentModel = "";
  /** 模型是否正在加载中 */
  private loading = false;
  /** 连续检测定时器 */
  private continuousTimer: ReturnType<typeof setInterval> | null = null;
  /** 每个摄像头最新帧缓存（用于连续检测） */
  private latestFrames = new Map<string, { data: Buffer; timestamp: number }>();
  /** 帧事件取消订阅函数 */
  private unsubFrame: (() => void) | null = null;
  /** 变动触发模式的取消订阅函数 */
  private unsubMotion: (() => void) | null = null;
  /** 待检测摄像头队列 */
  private detectQueue: string[] = [];
  /** 每个摄像头最近一次完成推理的时间（用于跳过过密请求） */
  private lastDetectTime = new Map<string, number>();
  /** 上一次检测结果指纹（用于去重通知） */
  private lastDetectFingerprint = new Map<string, string>();
  /** 每个摄像头的连续空检测计数（用于智能降频） */
  private emptyDetectStreak = new Map<string, number>();
  /** 智能降频：连续空检测达到此值时间隔翻倍 */
  private static readonly IDLE_SLOWDOWN_THRESHOLD = 5;
  /** 最大降频倍数 */
  private static readonly MAX_IDLE_MULTIPLIER = 4;
  /** 每个摄像头的目标追踪器 */
  private trackers = new Map<string, ObjectTracker>();
  /** trackName 缓存：cameraId:trackId -> name，定期刷新 */
  private trackNameCache = new Map<string, string>();
  /** dominantColor 缓存：trackId -> color，随 trackNameCache 同步刷新 */
  private trackColorCache = new Map<number, string>();
  /** 缓存刷新定时器 */
  private trackNameCacheTimer: ReturnType<typeof setInterval> | null = null;

  /** CLIP 语义标签缓存：trackId → semanticLabel */
  private semanticLabelCache = new Map<number, string>();

  constructor(
    private runtimeConfig: RuntimeConfig,
    private eventBus: EventBus,
    private annotator: Annotator,
    private modelCacheDir: string,
    private trackStorage?: TrackStorage,
    private trackLabelStorage?: TrackLabelStorage,
    private trajectoryStorage?: TrackTrajectoryStorage,
    private clipService?: ClipService,
  ) {}

  /** 注入 MotionDetector 引用（用于查询最新帧差异比率，跳过静态帧推理） */
  private motionDetector: { getLatestRatio(cameraId: string): number } | null = null;

  setMotionDetector(md: { getLatestRatio(cameraId: string): number }): void {
    this.motionDetector = md;
  }

  /** 异步初始化：加载模型 */
  async init(): Promise<void> {
    const config = this.runtimeConfig.get().ai;
    if (!config.enabled) {
      console.log("[AiDetector] AI 检测已禁用");
      return;
    }

    /** 预下载模型文件 */
    await ensureModelCached(config.model, this.modelCacheDir, hfEndpoint);

    await this.loadModel(config.model);

    /** 从持久化存储恢复 trackId 计数器，避免重启后 ID 重叠导致命名失效 */
    if (this.trackStorage) {
      const maxId = this.trackStorage.getMaxTrackId();
      if (maxId > 0) {
        initNextTrackId(maxId);
        console.log(`[AiDetector] trackId 计数器已恢复: nextId=${maxId + 1}`);
      }
    }

    /** 启动检测模式 */
    this.startDetection();

    /** 定期刷新 trackName 和 trackColor 缓存（30秒） */
    if (this.trackLabelStorage) {
      this.trackNameCacheTimer = setInterval(() => {
        this.trackNameCache.clear();
        this.trackColorCache.clear();
      }, 30000);
    }
  }

  /** 启动 Worker 线程并加载模型 */
  private async loadModel(modelName: string): Promise<void> {
    console.log(`[AiDetector] 正在加载模型: ${modelName} (Worker 线程)...`);
    this.loading = true;

    /** 销毁旧 Worker */
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }

    /** Worker 文件路径 */
    const workerPath = join(dirname(fileURLToPath(import.meta.url)), "detect-worker.ts");

    return new Promise<void>((resolve, reject) => {
      let lastError: unknown;
      let attempt = 0;

      const tryLoad = () => {
        attempt++;
        if (attempt > MAX_RETRIES) {
          this.loading = false;
          reject(lastError);
          return;
        }

        console.log(`[AiDetector] 第 ${attempt}/${MAX_RETRIES} 次尝试加载...`);

        const worker = new Worker(workerPath, {
          workerData: { model: modelName, cacheDir: this.modelCacheDir },
        } as ConstructorParameters<typeof Worker>[1] & { workerData: unknown });

        worker.on("message", (msg: { type: string; data?: WorkerDetectResult; error?: string }) => {
          if (msg.type === "ready") {
            this.worker = worker;
            this.currentModel = modelName;
            this.loading = false;
            this.initialized = true;
            console.log(`[AiDetector] 模型加载完成: ${modelName}`);
            resolve();
          } else if (msg.type === "result" && msg.data) {
            const result = msg.data;
            const pending = pendingRequests.get(result.id);
            if (pending) {
              pendingRequests.delete(result.id);
              pending.resolve(result);
            }
          } else if (msg.type === "error") {
            lastError = new Error(msg.error);
            worker.terminate();
            if (attempt < MAX_RETRIES) {
              const delay = RETRY_BASE_DELAY * attempt;
              console.log(`[AiDetector] ${delay / 1000}s 后重试...`);
              setTimeout(tryLoad, delay);
            } else {
              tryLoad();
            }
          }
        });

        worker.on("error", (err: Error) => {
          lastError = err;
          console.error(`[AiDetector] Worker 错误: ${err.message}`);
          worker.terminate();
          if (attempt < MAX_RETRIES) {
            const delay = RETRY_BASE_DELAY * attempt;
            console.log(`[AiDetector] ${delay / 1000}s 后重试...`);
            setTimeout(tryLoad, delay);
          } else {
            this.loading = false;
            reject(lastError);
          }
        });
      };

      tryLoad();
    });
  }

  /** 向 Worker 发送推理请求 */
  private requestDetect(cameraId: string, jpeg: Buffer, timestamp: number): Promise<WorkerDetectResult> {
    return new Promise((resolve) => {
      const id = ++requestId;
      const aiConfig = this.runtimeConfig.get().ai;
      pendingRequests.set(id, { resolve, cameraId, jpeg, timestamp });

      /** importantLabels 用于过滤检测结果（YOLO 使用 COCO 80 类，直接传标签名） */
      const labels = aiConfig.importantLabels;

      this.worker?.postMessage({
        type: "detect",
        data: {
          id,
          cameraId,
          jpeg,
          timestamp,
          inputWidth: this.runtimeConfig.getAiInputWidth(cameraId),
          threshold: this.runtimeConfig.getAiThreshold(cameraId),
          maxDetections: aiConfig.maxDetections,
          labels,
        },
      });
    });
  }

  /** 摄像头离线清理取消订阅 */
  private unsubCameraOffline: (() => void) | null = null;

  /** 根据配置启动检测模式 */
  private startDetection(): void {
    const config = this.runtimeConfig.get().ai;

    /** 摄像头离线时清理该摄像头的所有缓存 */
    this.unsubCameraOffline = this.eventBus.on("camera:offline", ({ cameraId }) => {
      this.latestFrames.delete(cameraId);
      this.lastDetectTime.delete(cameraId);
      this.lastDetectFingerprint.delete(cameraId);
      this.trackers.delete(cameraId);
      this.trackNameCache.forEach((_v, k) => { if (k.startsWith(`${cameraId}:`)) this.trackNameCache.delete(k); });
      this.semanticLabelCache.forEach((_v, k) => { /* trackId 是全局的，离线时不清理 */ });
    });

    if (config.mode === "continuous") {
      /** 帧驱动模式：每收到新帧时检查间隔，满足条件立即推理 */
      this.unsubFrame = this.eventBus.on("detect:frame", ({ cameraId, data, timestamp }) => {
        this.latestFrames.set(cameraId, { data, timestamp });
        const camInterval = this.getEffectiveInterval(cameraId);
        const lastTime = this.lastDetectTime.get(cameraId) ?? 0;
        if (timestamp - lastTime >= camInterval * 0.8) {
          this.detect(cameraId, data, timestamp).catch(err => {
            console.error(`[AiDetector] 检测失败 [${cameraId}]:`, err);
          });
        }
      });

      /** 定时器兜底：防止帧事件丢失时漏检 */
      this.startContinuousLoop(config.interval);
      console.log(`[AiDetector] 连续检测模式（帧驱动），间隔 ${config.interval}ms`);
    } else {
      this.unsubMotion = this.eventBus.on("motion", ({ cameraId, data, timestamp }) => {
        this.detect(cameraId, data, timestamp);
      });
      console.log("[AiDetector] 变动触发检测模式");
    }
  }

  /** 启动连续检测循环 */
  private baseInterval = 0;
  private globalIdleBoosted = false;
  private startContinuousLoop(interval: number): void {
    if (this.continuousTimer) clearInterval(this.continuousTimer);
    this.baseInterval = interval;
    /** 定时器使用全局 interval，per-camera 间隔在 processQueue 中按摄像头分别判断 */
    this.continuousTimer = setInterval(() => {
      const now = Date.now();
      for (const [cameraId, frame] of this.latestFrames) {
        const camInterval = this.getEffectiveInterval(cameraId);
        if (now - frame.timestamp > camInterval * 3) continue;
        if (!this.detectQueue.includes(cameraId)) {
          this.detectQueue.push(cameraId);
        }
      }
      this.processQueue();
      this.adjustGlobalInterval();
    }, interval);
  }

  /** 动态调整全局定时器：所有摄像头深度 idle 时降频，有活动时恢复 */
  private adjustGlobalInterval(): void {
    if (!this.continuousTimer || this.baseInterval === 0) return;
    const allDeepIdle = this.latestFrames.size > 0 && [...this.emptyDetectStreak.values()].every(
      s => s >= AiDetector.IDLE_SLOWDOWN_THRESHOLD * 2,
    );
    if (allDeepIdle && !this.globalIdleBoosted) {
      /** 全部深度 idle：全局定时器降到 2x 间隔 */
      clearInterval(this.continuousTimer);
      this.continuousTimer = setInterval(() => {
        const now = Date.now();
        for (const [cameraId, frame] of this.latestFrames) {
          const camInterval = this.getEffectiveInterval(cameraId);
          if (now - frame.timestamp > camInterval * 3) continue;
          if (!this.detectQueue.includes(cameraId)) {
            this.detectQueue.push(cameraId);
          }
        }
        this.processQueue();
        this.adjustGlobalInterval();
      }, this.baseInterval * 2);
      this.globalIdleBoosted = true;
    } else if (!allDeepIdle && this.globalIdleBoosted) {
      /** 有活动目标：恢复原始间隔 */
      clearInterval(this.continuousTimer);
      this.continuousTimer = setInterval(() => {
        const now = Date.now();
        for (const [cameraId, frame] of this.latestFrames) {
          const camInterval = this.getEffectiveInterval(cameraId);
          if (now - frame.timestamp > camInterval * 3) continue;
          if (!this.detectQueue.includes(cameraId)) {
            this.detectQueue.push(cameraId);
          }
        }
        this.processQueue();
        this.adjustGlobalInterval();
      }, this.baseInterval);
      this.globalIdleBoosted = false;
    }
  }

  /**
   * 并行发起所有待检测摄像头的推理请求
   * 不串行等待，Worker 内部 auto-skip 机制保证处理最新帧
   */
  /** 获取有效检测间隔（考虑智能降频） */
  private getEffectiveInterval(cameraId: string): number {
    const baseInterval = this.runtimeConfig.getAiInterval(cameraId);
    const streak = this.emptyDetectStreak.get(cameraId) ?? 0;
    if (streak < AiDetector.IDLE_SLOWDOWN_THRESHOLD) return baseInterval;
    /** 每超过阈值 5 次，倍数 +1，最高 4 倍 */
    const multiplier = Math.min(
      1 + Math.floor((streak - AiDetector.IDLE_SLOWDOWN_THRESHOLD) / AiDetector.IDLE_SLOWDOWN_THRESHOLD),
      AiDetector.MAX_IDLE_MULTIPLIER,
    );
    return baseInterval * multiplier;
  }

  private processQueue(): void {
    const now = Date.now();
    const batch = this.detectQueue.splice(0);
    for (const cameraId of batch) {
      const camInterval = this.getEffectiveInterval(cameraId);
      /** 始终使用该摄像头的最新帧（跳过中间帧） */
      const frame = this.latestFrames.get(cameraId);
      if (!frame) continue;
      /** 帧太旧 → 跳过 */
      if (now - frame.timestamp > camInterval * 3) continue;
      /** 推理间隔保护：避免同一摄像头过于频繁推理 */
      const lastTime = this.lastDetectTime.get(cameraId) ?? 0;
      if (now - lastTime < camInterval * 0.8) continue;
      this.lastDetectTime.set(cameraId, now);
      /** 不 await — 并行发起推理，结果通过 Promise 异步处理 */
      this.detect(cameraId, frame.data, frame.timestamp).catch(err => {
        console.error(`[AiDetector] 检测失败 [${cameraId}]:`, err);
      });
    }
  }

  /** 停止连续检测 */
  private stopContinuousLoop(): void {
    if (this.continuousTimer) {
      clearInterval(this.continuousTimer);
      this.continuousTimer = null;
    }
    if (this.unsubFrame) {
      this.unsubFrame();
      this.unsubFrame = null;
    }
    if (this.unsubMotion) {
      this.unsubMotion();
      this.unsubMotion = null;
    }
    if (this.unsubCameraOffline) {
      this.unsubCameraOffline();
      this.unsubCameraOffline = null;
    }
    this.latestFrames.clear();
    this.detectQueue = [];
    this.lastDetectTime.clear();
  }

  /** 运行时切换模型 */
  async reloadModel(modelName?: string): Promise<{ ok: boolean; model: string; error?: string }> {
    const target = modelName ?? this.runtimeConfig.get().ai.model;
    if (target === this.currentModel) {
      return { ok: true, model: this.currentModel };
    }
    if (this.loading) {
      return { ok: false, model: this.currentModel, error: "模型正在加载中" };
    }

    this.initialized = false;
    try {
      await this.loadModel(target);
      const ai = this.runtimeConfig.get().ai;
      this.runtimeConfig.patch({ ai: { ...ai, model: target } });
      return { ok: true, model: this.currentModel };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[AiDetector] 模型加载失败: ${msg}`);
      if (this.currentModel) {
        console.log(`[AiDetector] 回退到模型: ${this.currentModel}`);
        await this.loadModel(this.currentModel);
      }
      return { ok: false, model: this.currentModel, error: msg };
    }
  }

  /** 运行时切换检测模式 */
  setMode(mode: DetectMode, interval?: number): void {
    const ai = this.runtimeConfig.get().ai;
    if (ai.mode === mode && (mode === "motion" || ai.interval === interval)) return;

    this.stopContinuousLoop();

    const updatedInterval = interval ?? ai.interval;
    this.runtimeConfig.patch({ ai: { ...ai, mode, interval: updatedInterval } });

    this.startDetection();
  }

  /** 获取当前模型信息 */
  getModelInfo(): { model: string; loading: boolean; initialized: boolean } {
    return { model: this.currentModel, loading: this.loading, initialized: this.initialized };
  }

  /** 静态帧跳过：motion ratio 低于此阈值且上一帧也是空结果时跳过推理 */
  private static readonly STATIC_RATIO_THRESHOLD = 0.005;

  /** 执行目标检测（委托 Worker 线程推理） */
  private async detect(cameraId: string, jpeg: Buffer, timestamp: number): Promise<void> {
    if (!this.initialized || !this.worker) return;

    const aiConfig = this.runtimeConfig.get().ai;
    if (!aiConfig.enabled) return;

    /** 静态帧跳过：ratio 极低且上一帧也是空结果 → 跳过推理，直接发射无变化事件 */
    if (this.motionDetector && aiConfig.mode === "continuous") {
      const ratio = this.motionDetector.getLatestRatio(cameraId);
      const streak = this.emptyDetectStreak.get(cameraId) ?? 0;
      if (ratio < AiDetector.STATIC_RATIO_THRESHOLD && streak >= AiDetector.IDLE_SLOWDOWN_THRESHOLD) {
        this.emptyDetectStreak.set(cameraId, streak + 1);
        this.lastDetectTime.set(cameraId, Date.now());
        this.annotator.setLatestFrame(cameraId, jpeg, []);
        this.eventBus.emit("detect", {
          cameraId,
          timestamp,
          detections: [],
          frameImage: jpeg,
          changed: false,
          inferMs: 0,
        });
        return;
      }
    }

    /** 更新最后推理时间（防止帧驱动模式重复触发） */
    this.lastDetectTime.set(cameraId, Date.now());

    try {
      const t0 = performance.now();

      /** 推理在 Worker 线程执行 */
      const result = await this.requestDetect(cameraId, jpeg, timestamp);

      if (result.error) {
        console.error(`[AiDetector] Worker 推理失败: ${result.error}`);
        return;
      }

      const detections: Detection[] = result.detections.map(item => ({
        label: item.label,
        score: item.score,
        box: item.box,
      }));

      /** 目标追踪：跨帧保持同一 ID */
      let tracker = this.trackers.get(cameraId);
      if (!tracker) {
        tracker = new ObjectTracker();
        this.trackers.set(cameraId, tracker);
      }
      const trackResult = tracker.update(detections);

      /** 新目标出现时保存裁剪快照到 TrackStorage */
      if (this.trackStorage && trackResult.appeared.length > 0) {
        for (const target of trackResult.appeared) {
          this.trackStorage.upsert(
            target.trackId,
            target.label,
            cameraId,
            timestamp,
            jpeg,
            target.box,
            target.score,
          ).then(() => {
            /** 快照保存后，执行 CLIP 零样本分类（同时产出 image embedding） */
            const record = this.trackStorage!.getRecord(target.trackId);

            if (this.clipService && target.box) {
              this.clipService.classifyTarget(jpeg, target.box, target.label)
                .then(result => {
                  /** 零样本分类结果 */
                  const top = ClipService.getTopLabels(result, 1);
                  if (top.length > 0 && top[0]!.score > 0.15) {
                    this.semanticLabelCache.set(target.trackId, top[0]!.label);
                    if (this.trackStorage) {
                      this.trackStorage.setSemanticLabel(target.trackId, top[0]!.label);
                    }
                    console.log(`[AiDetector] CLIP 分类: track#${target.trackId} (${target.label}) → ${top[0]!.label} (${(top[0]!.score * 100).toFixed(0)}%)`);
                  }

                  /** 复用同一推理产出的 image embedding（无需二次推理） */
                  const clipEmbedding = result.imageEmbedding;
                  if (clipEmbedding?.length && this.trackStorage) {
                    this.trackStorage.setClipEmbedding(target.trackId, clipEmbedding);
                  }

                  /** 用 embedding 做高精度 ReID 匹配 */
                  if (!record?.dhash && !clipEmbedding?.length) return;
                  const matches = this.trackStorage!.findSimilar(
                    target.trackId, cameraId, target.label,
                    record?.dhash ?? "", 0.4,
                    record?.colorHist, record?.lbpHist,
                    clipEmbedding?.length ? clipEmbedding : record?.clipEmbedding,
                  );
                  if (matches.length > 0) {
                    this.eventBus.emit("track:match-suggest", {
                      cameraId,
                      timestamp,
                      trackId: target.trackId,
                      label: target.label,
                      matches,
                    });
                    const best = matches[0]!;
                    const autoThreshold = this.runtimeConfig.get().ai.autoMatchThreshold;
                    if (autoThreshold > 0 && best.distance < autoThreshold && this.trackLabelStorage) {
                      this.trackLabelStorage.upsert(cameraId, target.trackId, target.label, best.customName);
                      this.trackStorage!.setCustomName(target.trackId, best.customName);
                      this.trackNameCache.delete(`${cameraId}:${target.trackId}`);
                      this.eventBus.emit("track:label-updated", {
                        cameraId,
                        trackId: target.trackId,
                        name: best.customName,
                      });
                      console.log(`[AiDetector] 自动关联: track#${target.trackId} → ${best.customName} (${(best.distance * 100).toFixed(0)}%)`);
                    }
                  }
                })
                .catch(() => { /* CLIP 推理失败不影响主流程 */ });
            }
          }).catch(err => console.error(`[AiDetector] 追踪快照保存失败:`, err));
        }
      }
      /** 更新已有活跃目标的 lastSeen/hitCount */
      if (this.trackStorage && trackResult.detections.length > 0) {
        const appearedIds = new Set(trackResult.appeared.map(a => a.trackId));
        const existing = trackResult.detections
          .filter(d => d.trackId != null && !appearedIds.has(d.trackId));
        if (existing.length > 0) {
          this.trackStorage.touchSeen(existing.map(d => ({ trackId: d.trackId!, cameraId })), timestamp);
          /** 对置信度最高的已有目标尝试更新快照（每帧最多 3 个，按置信度降序） */
          existing.sort((a, b) => b.score - a.score);
          const candidates = existing.filter(d => d.box).slice(0, 3);
          for (const det of candidates) {
            this.trackStorage.tryUpdateSnapshot(det.trackId!, cameraId, jpeg, det.box!, det.score)
              .then(updated => {
                if (!updated) return;
                const rec = this.trackStorage!.getRecord(det.trackId!);
                if (!rec || rec.customName || (!rec.dhash && !rec.clipEmbedding?.length)) return;
                /** 快照更新时重新做 CLIP 分类 + embedding（已有完整数据时跳过，减少 ~80% 推理） */
                const hasFullClipData = rec.clipEmbedding?.length && rec.semanticLabel;
                if (!hasFullClipData && this.clipService && det.box) {
                  this.clipService.classifyTarget(jpeg, det.box, rec.label)
                    .then(result => {
                      /** 更新 semanticLabel（新快照可能提供更准确的分类） */
                      const top = ClipService.getTopLabels(result, 1);
                      if (top.length > 0 && top[0]!.score > 0.15) {
                        this.semanticLabelCache.set(det.trackId!, top[0]!.label);
                        this.trackStorage!.setSemanticLabel(det.trackId!, top[0]!.label);
                      }
                      /** 更新 CLIP embedding */
                      if (result.imageEmbedding?.length) {
                        this.trackStorage!.setClipEmbedding(det.trackId!, result.imageEmbedding);
                      }
                    })
                    .catch(() => { /* CLIP 推理失败不影响主流程 */ });
                }
                const matches = this.trackStorage!.findSimilar(det.trackId!, cameraId, rec.label, rec.dhash ?? "", 0.4, rec.colorHist, rec.lbpHist, rec.clipEmbedding);
                if (matches.length === 0) return;
                const top = matches[0]!;
                const autoThreshold = this.runtimeConfig.get().ai.autoMatchThreshold;
                if (autoThreshold > 0 && top.distance < autoThreshold && this.trackLabelStorage) {
                  this.trackLabelStorage.upsert(cameraId, det.trackId!, rec.label, top.customName);
                  this.trackStorage!.setCustomName(det.trackId!, top.customName);
                  this.trackNameCache.delete(`${cameraId}:${det.trackId}`);
                  this.eventBus.emit("track:label-updated", {
                    cameraId,
                    trackId: det.trackId,
                    name: top.customName,
                  });
                  console.log(`[AiDetector] 延迟匹配: track#${det.trackId} → ${top.customName} (${(top.distance * 100).toFixed(0)}%)`);
                }
              })
              .catch(() => { /* 快照更新失败不影响主流程 */ });
          }
        }
      }

      const totalMs = performance.now() - t0;

      /** 智能降频：无目标时增加空检测计数，有目标时重置 */
      if (trackResult.detections.length === 0) {
        this.emptyDetectStreak.set(cameraId, (this.emptyDetectStreak.get(cameraId) ?? 0) + 1);
      } else {
        this.emptyDetectStreak.set(cameraId, 0);
      }

      /** 去重（在标注前计算，避免无变化时浪费标注开销） */
      const prevFp = this.lastDetectFingerprint.get(cameraId);
      const changed = result.fingerprint !== prevFp;
      this.lastDetectFingerprint.set(cameraId, result.fingerprint);

      /** 发射追踪目标出现/消失事件 */
      for (const target of trackResult.appeared) {
        const trackName = this.lookupTrackName(cameraId, target.trackId);
        this.eventBus.emit("track:appeared", {
          cameraId,
          timestamp,
          trackId: target.trackId,
          label: target.label,
          score: target.score,
          trackName: trackName || undefined,
          semanticLabel: target.trackId ? this.semanticLabelCache.get(target.trackId) : undefined,
        });
      }
      for (const target of trackResult.disappeared) {
        const trackName = this.lookupTrackName(cameraId, target.trackId);
        this.eventBus.emit("track:disappeared", {
          cameraId,
          timestamp,
          trackId: target.trackId,
          label: target.label,
          trackName: trackName || undefined,
          semanticLabel: target.trackId ? this.semanticLabelCache.get(target.trackId) : undefined,
        });
      }

      /** 写入轨迹采样点（持久化追踪目标的位置历史） */
      if (this.trajectoryStorage && trackResult.detections.length > 0) {
        const trajItems = trackResult.detections
          .filter(d => d.trackId != null && d.box)
          .map(d => ({
            trackId: d.trackId!,
            cx: (d.box.xmin + d.box.xmax) / 2,
            cy: (d.box.ymin + d.box.ymax) / 2,
            w: d.box.xmax - d.box.xmin,
            h: d.box.ymax - d.box.ymin,
          }));
        if (trajItems.length > 0) {
          this.trajectoryStorage.insertBatch(cameraId, timestamp, trajItems);
        }
      }

      /** 为检测结果附带用户自定义名称、主色调和语义标签 */
      const enricheddetections = trackResult.detections.map(d => {
        const trackName = d.trackId ? this.lookupTrackName(cameraId, d.trackId) : undefined;
        const dominantColor = d.trackId ? this.lookupDominantColor(d.trackId) : undefined;
        const semanticLabel = d.trackId ? this.semanticLabelCache.get(d.trackId) : undefined;
        return { ...d, trackName: trackName || undefined, dominantColor, semanticLabel };
      });

      /** 缓存最新帧和 enriched 检测结果（用于按需生成标注图） */
      this.annotator.setLatestFrame(cameraId, jpeg, enricheddetections);

      this.eventBus.emit("detect", {
        cameraId,
        timestamp,
        detections: enricheddetections,
        frameImage: jpeg,
        changed,
        inferMs: result.inferMs,
      });
      const trackIds = trackResult.detections.map(d => `${d.label}#${d.trackId}`).join(", ");
      console.log(`[Perf][AI][${cameraId}] ${trackResult.detections.length} 目标 (${trackIds || "-"}), infer=${result.inferMs.toFixed(0)}ms, total=${totalMs.toFixed(0)}ms`);
    } catch (err) {
      console.error(`[AiDetector] 检测失败:`, err);
    }
  }

  /** 销毁检测器 */
  dispose(): void {
    this.stopContinuousLoop();
    if (this.trackNameCacheTimer) {
      clearInterval(this.trackNameCacheTimer);
      this.trackNameCacheTimer = null;
    }
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.initialized = false;
  }

  /** 查找 trackName（带内存缓存，30 秒刷新） */
  private lookupTrackName(cameraId: string, trackId: number): string | undefined {
    if (!this.trackLabelStorage) return undefined;
    const key = `${cameraId}:${trackId}`;
    const cached = this.trackNameCache.get(key);
    if (cached !== undefined) return cached || undefined;
    const name = this.trackLabelStorage.findByTrack(cameraId, trackId)?.name ?? "";
    this.trackNameCache.set(key, name);
    return name || undefined;
  }

  /** 查找 dominantColor（带内存缓存，30 秒刷新） */
  private lookupDominantColor(trackId: number): string | undefined {
    if (!this.trackStorage) return undefined;
    const cached = this.trackColorCache.get(trackId);
    if (cached !== undefined) return cached || undefined;
    const record = this.trackStorage.getRecord(trackId);
    const color = record?.colorHist ? TrackStorage.extractDominantColor(record.colorHist) : "";
    this.trackColorCache.set(trackId, color);
    return color || undefined;
  }

  /**
   * 命名后反向关联：扫描所有外观相似的未命名目标并自动关联
   * 在 POST /api/track-labels 命名保存后调用
   */
  propagateName(trackId: number, name: string, sourceCameraId: string): void {
    if (!this.trackStorage || !this.trackLabelStorage) return;
    const record = this.trackStorage.getRecord(trackId);
    if (!record?.clipEmbedding?.length && !record?.dhash) return;

    const autoThreshold = this.runtimeConfig.get().ai.autoMatchThreshold;
    if (autoThreshold <= 0) return;

    /** 查找外观相似的目标 */
    const matches = this.trackStorage.findSimilar(
      trackId, sourceCameraId, record.label, record.dhash ?? "", 0.4,
      record.colorHist, record.lbpHist, record.clipEmbedding,
    );

    for (const match of matches) {
      if (match.distance >= autoThreshold) continue;
      /** 跳过已命名的目标 */
      const matchRec = this.trackStorage.getRecord(match.trackId);
      if (matchRec?.customName) continue;
      /** 为匹配的目标设置相同名称 */
      for (const camId of matchRec?.cameraIds ?? []) {
        this.trackLabelStorage.upsert(camId, match.trackId, matchRec?.label ?? record.label, name);
      }
      this.trackStorage.setCustomName(match.trackId, name);
      /** 清除缓存 */
      for (const camId of matchRec?.cameraIds ?? []) {
        this.trackNameCache.delete(`${camId}:${match.trackId}`);
      }
      /** 广播更新 */
      const camId = matchRec?.cameraIds[0] ?? sourceCameraId;
      this.eventBus.emit("track:label-updated", { cameraId: camId, trackId: match.trackId, name });
      console.log(`[AiDetector] 命名传播: track#${match.trackId} → ${name} (${(match.distance * 100).toFixed(0)}%)`);
    }
  }
}
