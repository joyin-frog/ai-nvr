import { type EventBus } from "@/event-bus";

/** 多模态 LLM 配置 */
export interface LlmConfig {
  /** 是否启用多模态分析 */
  enabled: boolean;
  /** LLM API 端点 URL（OpenAI 兼容格式） */
  apiUrl: string;
  /** 模型名称 */
  model: string;
  /** 生成最大 token 数 */
  maxTokens: number;
  /** 分析触发间隔（毫秒，每个摄像头独立节流） */
  interval: number;
  /** 推理时图片缩放宽度（0=使用检测帧原始分辨率，建议 640） */
  imageWidth: number;
  /** 系统提示词 */
  systemPrompt: string;
  /** 分析触发条件：哪些事件触发 LLM 分析 */
  triggers: string[];
}

/** LLM 场景分析结果 */
export interface LlmSceneResult {
  /** 摄像头 ID */
  cameraId: string;
  /** 时间戳 */
  timestamp: number;
  /** LLM 生成的场景描述 */
  description: string;
  /** 触发此分析的事件类型 */
  trigger: string;
  /** 推理耗时（毫秒） */
  inferMs: number;
  [key: string]: unknown;
}

const DEFAULT_SYSTEM_PROMPT = `You are an intelligent security camera analyst. Analyze the surveillance image and provide a concise scene description in the user's language.
Focus on:
1. What objects/people/animals are present and what they are doing
2. Any unusual or noteworthy activities
3. Potential safety concerns
Keep the description under 3 sentences. Be factual and specific.`;

const DEFAULT_TRIGGERS = ["track:appeared", "track:enter-zone", "track:loiter"];

/**
 * 多模态 LLM 分析器
 * 监听检测事件，将关键帧图像发送给多模态 LLM 生成语义化场景描述
 * 使用 OpenAI 兼容 API 格式（支持 LM Studio、Ollama 等）
 */
export class MultimodalAnalyzer {
  private eventBus: EventBus;
  private config: LlmConfig;
  /** 每个摄像头上次分析时间（节流） */
  private lastAnalysisTime = new Map<string, number>();
  /** 是否正在分析中（每个摄像头独立） */
  private analyzing = new Set<string>();
  /** 取消订阅函数列表 */
  private unsubs: (() => void)[] = [];
  /** 每个摄像头最新帧缓存 */
  private latestFrames = new Map<string, { data: Buffer; timestamp: number }>();
  /** 帧更新取消订阅 */
  private unsubFrame: (() => void) | null = null;

  constructor(eventBus: EventBus, config: LlmConfig) {
    this.eventBus = eventBus;
    this.config = config;
  }

  /** 更新配置 */
  updateConfig(config: LlmConfig): void {
    const wasEnabled = this.config.enabled;
    this.config = config;
    if (!wasEnabled && config.enabled) {
      this.start();
    } else if (wasEnabled && !config.enabled) {
      this.stop();
    }
  }

  /** 启动分析器 */
  start(): void {
    if (!this.config.enabled) return;
    this.stop();

    /** 缓存检测帧（用于后续 LLM 分析时获取最新图像） */
    this.unsubFrame = this.eventBus.on("detect", (payload) => {
      this.latestFrames.set(payload.cameraId, {
        data: payload.frameImage,
        timestamp: payload.timestamp,
      });
    });

    /** 订阅配置的触发事件 */
    const triggers = this.config.triggers.length > 0 ? this.config.triggers : DEFAULT_TRIGGERS;
    for (const trigger of triggers) {
      const unsub = this.eventBus.on(trigger as keyof import("@/event-bus").EventPayloads, (payload: { cameraId: string; timestamp?: number }) => {
        this.scheduleAnalysis(payload.cameraId, trigger, payload.timestamp ?? Date.now());
      });
      this.unsubs.push(unsub);
    }

    console.log(`[MultimodalAnalyzer] 已启动 (model=${this.config.model}, triggers=[${triggers.join(",")}], interval=${this.config.interval}ms)`);
  }

  /** 停止分析器 */
  stop(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    if (this.unsubFrame) {
      this.unsubFrame();
      this.unsubFrame = null;
    }
    this.lastAnalysisTime.clear();
    this.analyzing.clear();
  }

  /** 调度分析（带节流） */
  private scheduleAnalysis(cameraId: string, trigger: string, timestamp: number): void {
    /** 正在分析中则跳过 */
    if (this.analyzing.has(cameraId)) return;

    /** 节流检查 */
    const lastTime = this.lastAnalysisTime.get(cameraId) ?? 0;
    if (timestamp - lastTime < this.config.interval) return;

    /** 获取最新帧 */
    const frame = this.latestFrames.get(cameraId);
    if (!frame) return;

    this.analyzing.add(cameraId);
    this.lastAnalysisTime.set(cameraId, timestamp);

    this.analyzeScene(cameraId, frame.data, trigger, timestamp)
      .catch((err) => {
        console.warn(`[MultimodalAnalyzer] 分析失败 (${cameraId}):`, err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        this.analyzing.delete(cameraId);
      });
  }

  /** 执行多模态分析 */
  private async analyzeScene(cameraId: string, jpeg: Buffer, trigger: string, timestamp: number): Promise<void> {
    const t0 = performance.now();

    /** 将 JPEG 转为 base64 data URL */
    let imageDataUrl: string;
    if (this.config.imageWidth > 0) {
      /** 缩放图片减少传输和推理开销 */
      const sharp = await import("sharp");
      const resized = await sharp.default(jpeg)
        .resize(this.config.imageWidth)
        .jpeg({ quality: 80 })
        .toBuffer();
      imageDataUrl = `data:image/jpeg;base64,${resized.toString("base64")}`;
    } else {
      imageDataUrl = `data:image/jpeg;base64,${jpeg.toString("base64")}`;
    }

    /** 构建 OpenAI 兼容请求 */
    const systemPrompt = this.config.systemPrompt || DEFAULT_SYSTEM_PROMPT;
    const body = {
      model: this.config.model,
      messages: [
        { role: "system" as const, content: systemPrompt },
        {
          role: "user" as const,
          content: [
            { type: "text" as const, text: "Analyze this surveillance camera image:" },
            { type: "image_url" as const, image_url: { url: imageDataUrl } },
          ],
        },
      ],
      max_tokens: this.config.maxTokens,
      temperature: 0.3,
    };

    const response = await fetch(this.config.apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`LLM API ${response.status}: ${text.slice(0, 200)}`);
    }

    const result = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const description = result.choices?.[0]?.message?.content?.trim() ?? "";
    if (!description) return;

    const inferMs = performance.now() - t0;

    const sceneResult: LlmSceneResult = {
      cameraId,
      timestamp,
      description,
      trigger,
      inferMs,
    };

    this.eventBus.emit("llm:scene" as keyof import("@/event-bus").EventPayloads, sceneResult as never);
    console.debug(`[MultimodalAnalyzer] ${cameraId}: "${description.slice(0, 80)}" (${Math.round(inferMs)}ms)`);
  }
}
