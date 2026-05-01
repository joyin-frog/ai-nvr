import { Worker } from "node:worker_threads";
import { ensureModelCached } from "./model-downloader";

/** 设置模型下载源（HF_ENDPOINT 仅对 Python SDK 生效，JS 库需设置 env.remoteHost） */
const hfEndpoint = process.env.HF_ENDPOINT ?? "https://hf-mirror.com";

/** 模型加载最大重试次数 */
const MAX_RETRIES = 3;
/** 重试基础延迟（毫秒） */
const RETRY_BASE_DELAY = 5000;
import { type Detection, type DetectMode } from "./types";
import { type Annotator } from "./annotator";
import { type EventBus } from "@/event-bus";
import { type RuntimeConfig } from "@/runtime-config";
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
  /** 待检测摄像头队列 */
  private detectQueue: string[] = [];
  /** 队列处理中 */
  private processingQueue = false;
  /** 上一次检测结果指纹（用于去重通知） */
  private lastDetectFingerprint = new Map<string, string>();

  constructor(
    private runtimeConfig: RuntimeConfig,
    private eventBus: EventBus,
    private annotator: Annotator,
    private modelCacheDir: string,
  ) {}

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

    /** 启动检测模式 */
    this.startDetection();
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

      this.worker?.postMessage({
        type: "detect",
        data: {
          id,
          cameraId,
          jpeg,
          timestamp,
          inputWidth: aiConfig.inputWidth,
          threshold: aiConfig.threshold,
          maxDetections: aiConfig.maxDetections,
        },
      });
    });
  }

  /** 根据配置启动检测模式 */
  private startDetection(): void {
    const config = this.runtimeConfig.get().ai;

    if (config.mode === "continuous") {
      this.unsubFrame = this.eventBus.on("frame", ({ cameraId, data, timestamp }) => {
        this.latestFrames.set(cameraId, { data, timestamp });
      });

      this.startContinuousLoop(config.interval);
      console.log(`[AiDetector] 连续检测模式，间隔 ${config.interval}ms`);
    } else {
      this.eventBus.on("motion", ({ cameraId, data, timestamp }) => {
        this.detect(cameraId, data, timestamp);
      });
      console.log("[AiDetector] 变动触发检测模式");
    }
  }

  /** 启动连续检测循环 */
  private startContinuousLoop(interval: number): void {
    if (this.continuousTimer) clearInterval(this.continuousTimer);
    this.continuousTimer = setInterval(() => {
      for (const [cameraId, frame] of this.latestFrames) {
        if (Date.now() - frame.timestamp > interval * 3) continue;
        if (!this.detectQueue.includes(cameraId)) {
          this.detectQueue.push(cameraId);
        }
      }
      this.processQueue(interval);
    }, interval);
  }

  /** 依次处理检测队列 */
  private async processQueue(interval: number): Promise<void> {
    if (this.processingQueue) return;
    this.processingQueue = true;
    while (this.detectQueue.length > 0) {
      const cameraId = this.detectQueue.shift()!;
      const frame = this.latestFrames.get(cameraId);
      if (!frame) continue;
      if (Date.now() - frame.timestamp > interval * 3) continue;
      await this.detect(cameraId, frame.data, frame.timestamp);
    }
    this.processingQueue = false;
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
    this.latestFrames.clear();
    this.detectQueue = [];
    this.processingQueue = false;
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

  /** 执行目标检测（委托 Worker 线程推理） */
  private async detect(cameraId: string, jpeg: Buffer, timestamp: number): Promise<void> {
    if (!this.initialized || !this.worker) return;

    const aiConfig = this.runtimeConfig.get().ai;
    if (!aiConfig.enabled) return;

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

      const totalMs = performance.now() - t0;

      /** 标注图片 */
      const t3 = performance.now();
      const annotatedImage = detections.length > 0
        ? await this.annotator.annotate(jpeg, detections)
        : jpeg;
      const annotateMs = performance.now() - t3;
      this.annotator.setLatest(cameraId, annotatedImage);

      /** 去重 */
      const prevFp = this.lastDetectFingerprint.get(cameraId);
      const changed = result.fingerprint !== prevFp;
      this.lastDetectFingerprint.set(cameraId, result.fingerprint);

      this.eventBus.emit("detect", {
        cameraId,
        timestamp,
        detections,
        annotatedImage,
        frameImage: jpeg,
        changed,
      });
      console.log(`[Perf][AI][${cameraId}] ${detections.length} 目标, resize=${result.resizeMs.toFixed(0)}ms, infer=${result.inferMs.toFixed(0)}ms, annotate=${annotateMs.toFixed(0)}ms, total=${totalMs.toFixed(0)}ms`);
    } catch (err) {
      console.error(`[AiDetector] 检测失败:`, err);
    }
  }

  /** 销毁检测器 */
  dispose(): void {
    this.stopContinuousLoop();
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.initialized = false;
  }
}
