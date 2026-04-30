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

    console.log(`[AiDetector] 正在加载模型: ${config.model}...`);
    this.detector = await pipeline("object-detection", config.model, {
      device: "cpu",
    });
    this.initialized = true;
    console.log("[AiDetector] 模型加载完成");

    /** 监听变动事件 */
    this.eventBus.on("motion", ({ cameraId, data, timestamp }) => {
      this.detect(cameraId, data, timestamp);
    });
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
