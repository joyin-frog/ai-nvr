import { pipeline, type ObjectDetectionPipeline } from "@huggingface/transformers";
import { type Detection } from "./types";
import { type Annotator } from "./annotator";
import { type EventBus } from "@/event-bus";
import { type RuntimeConfig } from "@/runtime-config";

/**
 * AI 目标检测器
 * 监听变动事件，对触发变动的帧执行目标检测
 * 使用 RuntimeConfig 获取实时配置（支持 API 热修改）
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

  constructor(
    private runtimeConfig: RuntimeConfig,
    private eventBus: EventBus,
    private annotator: Annotator,
  ) {}

  /** 异步初始化：加载模型 */
  async init(): Promise<void> {
    const config = this.runtimeConfig.get().ai;
    if (!config.enabled) {
      console.log("[AiDetector] AI 检测已禁用");
      return;
    }

    await this.loadModel(config.model);

    /** 监听变动事件 */
    this.eventBus.on("motion", ({ cameraId, data, timestamp }) => {
      this.detect(cameraId, data, timestamp);
    });
  }

  /** 加载指定模型 */
  private async loadModel(modelName: string): Promise<void> {
    console.log(`[AiDetector] 正在加载模型: ${modelName}...`);
    this.loading = true;
    this.detector = await pipeline("object-detection", modelName, {
      device: "cpu",
    });
    this.currentModel = modelName;
    this.loading = false;
    this.initialized = true;
    console.log(`[AiDetector] 模型加载完成: ${modelName}`);
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
      const raw = await this.detector(jpeg, {
        threshold: aiConfig.threshold,
      });

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

      if (detections.length > 0) {
        /** 标注图片 */
        const annotatedImage = await this.annotator.annotate(jpeg, detections);
        this.annotator.setLatest(cameraId, annotatedImage);

        this.eventBus.emit("detect", {
          cameraId,
          timestamp,
          detections,
          annotatedImage,
        });
      }
    } catch (err) {
      console.error(`[AiDetector] 检测失败:`, err);
    } finally {
      this.detecting = false;
    }
  }
}
