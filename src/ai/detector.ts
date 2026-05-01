import { pipeline, env as transformersEnv, type ObjectDetectionPipeline } from "@huggingface/transformers";
import sharp from "sharp";
import { ensureModelCached } from "./model-downloader";

/** 设置模型下载源（HF_ENDPOINT 仅对 Python SDK 生效，JS 库需设置 env.remoteHost） */
const hfEndpoint = process.env.HF_ENDPOINT ?? "https://hf-mirror.com";
transformersEnv.remoteHost = `${hfEndpoint}/`;

/** 模型加载最大重试次数 */
const MAX_RETRIES = 3;
/** 重试基础延迟（毫秒） */
const RETRY_BASE_DELAY = 5000;
import { type Detection, type DetectMode } from "./types";
import { type Annotator } from "./annotator";
import { type EventBus } from "@/event-bus";
import { type RuntimeConfig } from "@/runtime-config";

/**
 * AI 目标检测器
 * 支持两种模式：
 * - motion：变动事件触发检测（节省资源）
 * - continuous：按固定间隔连续检测（更及时，不漏检）
 */
export class AiDetector {
  /** Hugging Face 目标检测 pipeline */
  private detector: ObjectDetectionPipeline | null = null;
  /** 是否正在检测中（避免并发推理） */
  private detecting = false;
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

  constructor(
    private runtimeConfig: RuntimeConfig,
    private eventBus: EventBus,
    private annotator: Annotator,
    modelCacheDir: string,
  ) {
    /** 将模型缓存目录设置到 Hugging Face transformers 环境变量 */
    transformersEnv.cacheDir = modelCacheDir;
    console.log(`[AiDetector] 模型缓存目录: ${modelCacheDir}`);
  }

  /** 异步初始化：加载模型 */
  async init(): Promise<void> {
    const config = this.runtimeConfig.get().ai;
    if (!config.enabled) {
      console.log("[AiDetector] AI 检测已禁用");
      return;
    }

    /** 预下载模型文件（支持断点续传），确保缓存完整后再加载 */
    await ensureModelCached(config.model, transformersEnv.cacheDir!, hfEndpoint);

    await this.loadModel(config.model);

    /** 启动检测模式 */
    this.startDetection();
  }

  /** 根据配置启动检测模式 */
  private startDetection(): void {
    const config = this.runtimeConfig.get().ai;

    if (config.mode === "continuous") {
      /** 连续模式：订阅帧事件缓存最新帧，定时器驱动检测 */
      this.unsubFrame = this.eventBus.on("frame", ({ cameraId, data, timestamp }) => {
        this.latestFrames.set(cameraId, { data, timestamp });
      });

      this.startContinuousLoop(config.interval);
      console.log(`[AiDetector] 连续检测模式，间隔 ${config.interval}ms`);
    } else {
      /** 变动触发模式：监听 motion 事件 */
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
        /** 避免使用过旧的帧（超过间隔 3 倍） */
        if (Date.now() - frame.timestamp > interval * 3) continue;
        this.detect(cameraId, frame.data, frame.timestamp);
      }
    }, interval);
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
  }

  /** 加载指定模型（带重试） */
  private async loadModel(modelName: string): Promise<void> {
    console.log(`[AiDetector] 正在加载模型: ${modelName}...`);
    this.loading = true;

    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        console.log(`[AiDetector] 第 ${attempt}/${MAX_RETRIES} 次尝试加载...`);
        this.detector = await pipeline("object-detection", modelName, {
          device: "cpu",
        });
        this.currentModel = modelName;
        this.loading = false;
        this.initialized = true;
        console.log(`[AiDetector] 模型加载完成: ${modelName}`);
        return;
      } catch (err) {
        lastError = err;
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[AiDetector] 第 ${attempt} 次加载失败: ${msg}`);
        if (attempt < MAX_RETRIES) {
          const delay = RETRY_BASE_DELAY * attempt;
          console.log(`[AiDetector] ${delay / 1000}s 后重试...`);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    this.loading = false;
    throw lastError;
  }

  /** 运行时切换模型（先销毁旧 pipeline 再加载新的） */
  async reloadModel(modelName?: string): Promise<{ ok: boolean; model: string; error?: string }> {
    const target = modelName ?? this.runtimeConfig.get().ai.model;
    if (target === this.currentModel) {
      return { ok: true, model: this.currentModel };
    }
    if (this.loading) {
      return { ok: false, model: this.currentModel, error: "模型正在加载中" };
    }

    /** 销毁旧 pipeline */
    if (this.detector) {
      this.detector.dispose?.();
      this.detector = null;
    }

    this.initialized = false;
    try {
      await ensureModelCached(target, transformersEnv.cacheDir!, hfEndpoint);
      await this.loadModel(target);
      /** 更新 RuntimeConfig 中的模型名称 */
      const ai = this.runtimeConfig.get().ai;
      this.runtimeConfig.patch({ ai: { ...ai, model: target } });
      return { ok: true, model: this.currentModel };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[AiDetector] 模型加载失败: ${msg}`);
      /** 尝试回退到之前的模型 */
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

    /** 停止旧模式 */
    this.stopContinuousLoop();

    /** 更新配置 */
    const updatedInterval = interval ?? ai.interval;
    this.runtimeConfig.patch({ ai: { ...ai, mode, interval: updatedInterval } });

    /** 启动新模式 */
    this.startDetection();
  }

  /** 获取当前模型信息 */
  getModelInfo(): { model: string; loading: boolean; initialized: boolean } {
    return { model: this.currentModel, loading: this.loading, initialized: this.initialized };
  }

  /** 执行目标检测 */
  private async detect(cameraId: string, jpeg: Buffer, timestamp: number): Promise<void> {
    if (!this.initialized || !this.detector || this.detecting) return;

    /** 从 RuntimeConfig 获取最新的 AI 配置 */
    const aiConfig = this.runtimeConfig.get().ai;
    if (!aiConfig.enabled) return;

    this.detecting = true;
    try {
      const t0 = performance.now();
      /** 根据 inputWidth 配置决定推理输入分辨率 */
      let inferenceInput: Blob;
      let resizeMs = 0;
      if (aiConfig.inputWidth > 0) {
        const t1 = performance.now();
        const resized = await sharp(jpeg)
          .resize(aiConfig.inputWidth)
          .jpeg({ quality: 85 })
          .toBuffer();
        resizeMs = performance.now() - t1;
        inferenceInput = new Blob([resized]);
      } else {
        inferenceInput = new Blob([jpeg]);
      }

      const t2 = performance.now();
      const raw = await this.detector(inferenceInput, {
        threshold: aiConfig.threshold,
        percentage: true,
      });
      const inferMs = performance.now() - t2;

      /** 提取前 maxDetections 个结果 */
      const detections = (raw as Array<{
        score: number;
        label: string;
        box: { xmin: number; ymin: number; xmax: number; ymax: number };
      }>)
        .slice(0, aiConfig.maxDetections)
        .map<Detection>((item) => ({
          label: item.label,
          score: item.score,
          box: item.box,
        }));

      const totalMs = performance.now() - t0;

      /** 始终标注图片（即使无检测结果也要更新，清空之前的标注） */
      const t3 = performance.now();
      const annotatedImage = await this.annotator.annotate(jpeg, detections);
      const annotateMs = performance.now() - t3;
      this.annotator.setLatest(cameraId, annotatedImage);

      if (detections.length > 0) {
        this.eventBus.emit("detect", {
          cameraId,
          timestamp,
          detections,
          annotatedImage,
        });
      }
      console.log(`[Perf][AI][${cameraId}] ${detections.length} 目标, resize=${resizeMs.toFixed(0)}ms, infer=${inferMs.toFixed(0)}ms, annotate=${annotateMs.toFixed(0)}ms, total=${totalMs.toFixed(0)}ms`);
    } catch (err) {
      console.error(`[AiDetector] 检测失败:`, err);
    } finally {
      this.detecting = false;
    }
  }

  /** 销毁检测器（停止连续检测 + 释放模型） */
  dispose(): void {
    this.stopContinuousLoop();
    if (this.detector) {
      this.detector.dispose?.();
      this.detector = null;
    }
    this.initialized = false;
  }
}
