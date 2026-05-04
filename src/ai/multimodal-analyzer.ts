import { type EventBus } from "@/event-bus";
import { aiMetrics } from "./metrics";
import sharp from "sharp";

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
  /** 检测时附带上文帧的间隔（ms，0=仅当前帧，如 3000=同时发送前 3s/6s/9s 的帧） */
  contextIntervalMs: number;
}

/** 单个 LLM 模型配置（纯连接信息） */
export interface LlmModelConfig {
  /** 模型唯一 ID */
  id: string;
  /** 显示名称 */
  name: string;
  /** LLM API 端点 URL（OpenAI 兼容格式） */
  apiUrl: string;
  /** 模型名称 */
  model: string;
  /** 生成最大 token 数 */
  maxTokens: number;
}

/** 已解析的模型连接信息（用于 VLM 调用） */
export interface ResolvedModel {
  apiUrl: string;
  model: string;
  maxTokens: number;
}

/** 根据 modelId 从 models 列表中解析模型配置，找不到时 fallback 到 llm 默认值 */
export function resolveModel(
  models: LlmModelConfig[],
  llm: LlmConfig,
  modelId?: string,
): ResolvedModel {
  if (modelId) {
    const found = models.find(m => m.id === modelId);
    if (found) return { apiUrl: found.apiUrl, model: found.model, maxTokens: found.maxTokens };
  }
  /** fallback: models[0] 或 llm 默认值 */
  const primary = models[0];
  return {
    apiUrl: primary?.apiUrl || llm.apiUrl,
    model: primary?.model || llm.model,
    maxTokens: primary?.maxTokens || llm.maxTokens,
  };
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

const DEFAULT_SYSTEM_PROMPT = `Describe this surveillance scene. Objects, people, activities, anything unusual. Max 2 sentences. User's language.`;

/** 多帧场景分析 prompt（精简版） */
const MULTI_FRAME_SYSTEM_PROMPT = `Multiple frames from same camera. First=latest, rest=older. Describe current scene. Note any movement or changes. Max 2 sentences.`;


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
  /** 场景描述去重：最近一次描述文本（cameraId → description） */
  private lastDescription = new Map<string, string>();
  /** 取消订阅函数列表 */
  private unsubs: (() => void)[] = [];
  /** 每个摄像头最新帧缓存 */
  private latestFrames = new Map<string, { data: Buffer; timestamp: number }>();
  /** 帧更新取消订阅 */
  private unsubFrame: (() => void) | null = null;
  /** 是否已启动 */
  private started = false;
  /** 全局并发信号量（防止突发流量压垮 VLM 服务） */
  private concurrency = 0;
  private static readonly MAX_CONCURRENCY = 3;

  /** Recorder 引用（用于获取上下文帧） */
  private recorder: { getContextFrames(cameraId: string, now: number, intervalMs: number, maxFrames?: number): Array<{ data: Buffer; timestamp: number }> } | null = null;

  setRecorder(rec: { getContextFrames(cameraId: string, now: number, intervalMs: number, maxFrames?: number): Array<{ data: Buffer; timestamp: number }> }): void {
    this.recorder = rec;
  }
  private waitQueue: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];

  private acquire(): Promise<void> {
    if (this.concurrency < MultimodalAnalyzer.MAX_CONCURRENCY) {
      this.concurrency++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => { this.waitQueue.push({ resolve, reject }); });
  }

  private release(): void {
    this.concurrency--;
    const next = this.waitQueue.shift();
    if (next) {
      this.concurrency++;
      next.resolve();
    }
  }

  constructor(eventBus: EventBus, config: LlmConfig) {
    this.eventBus = eventBus;
    this.config = config;
  }

  /** 更新配置（配置变化时自动重启） */
  updateConfig(config: LlmConfig): void {
    const changed = this.config.enabled !== config.enabled
      || this.config.apiUrl !== config.apiUrl
      || this.config.model !== config.model
      || this.config.maxTokens !== config.maxTokens
      || this.config.interval !== config.interval
      || this.config.imageWidth !== config.imageWidth
      || this.config.systemPrompt !== config.systemPrompt;
    this.config = config;
    if (changed && this.started) {
      this.stop();
      if (config.enabled) this.start();
    } else if (!this.started && config.enabled) {
      this.start();
    }
  }

  /** 启动分析器 */
  start(): void {
    if (!this.config.enabled) return;
    this.stop();
    this.started = true;

    /** 缓存检测帧（用于后续 LLM 分析时获取最新图像） */
    this.unsubFrame = this.eventBus.on("detect:frame", (payload) => {
      this.latestFrames.set(payload.cameraId, {
        data: payload.data,
        timestamp: payload.timestamp,
      });
    });

    /** 订阅检测规则触发的事件 */
    const unsubRule = this.eventBus.on("detect:rule" as keyof import("@/event-bus").EventPayloads, (payload) => {
      const camId = (payload as Record<string, unknown>).cameraId as string;
      const ts = (payload as Record<string, unknown>).timestamp as number | undefined;
      if (!camId) return;
      this.scheduleAnalysis(camId, "detect:rule", ts ?? Date.now());
    });
    this.unsubs.push(unsubRule);

    console.log(`[MultimodalAnalyzer] 已启动 (model=${this.config.model}, interval=${this.config.interval}ms)`);
  }

  /** 停止分析器 */
  stop(): void {
    this.started = false;
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    if (this.unsubFrame) {
      this.unsubFrame();
      this.unsubFrame = null;
    }
    this.lastAnalysisTime.clear();
    this.analyzing.clear();
    this.latestFrames.clear();
    /** reject 所有等待中的 Promise，防止永久挂起 */
    for (const { reject } of this.waitQueue) {
      reject(new Error("Analyzer stopped"));
    }
    this.waitQueue = [];
    this.concurrency = 0;
  }

  /** 按需分析：前端触发时直接分析指定摄像头当前帧（跳过节流） */
  async analyzeNow(cameraId: string): Promise<LlmSceneResult | null> {
    const frame = this.latestFrames.get(cameraId);
    if (!frame) return null;
    await this.analyzeScene(cameraId, frame.data, "manual", Date.now());
    /** analyzeScene 通过 eventBus emit 结果，这里返回 null 即可（前端通过 WS 接收） */
    return null;
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
    await this.acquire();
    try {
      await this.doAnalyze(cameraId, jpeg, trigger, timestamp);
    } finally {
      this.release();
    }
  }

  /** 实际分析逻辑 */
  private async doAnalyze(cameraId: string, jpeg: Buffer, trigger: string, timestamp: number): Promise<void> {
    const t0 = performance.now();

    /** 图片缩放辅助函数 */
    const resizeImage = async (img: Buffer): Promise<string> => {
      if (this.config.imageWidth > 0) {
        const resized = await sharp(img)
          .resize(this.config.imageWidth)
          .jpeg({ quality: 80 })
          .toBuffer();
        return `data:image/jpeg;base64,${resized.toString("base64")}`;
      }
      return `data:image/jpeg;base64,${img.toString("base64")}`;
    };

    /** 获取上下文帧（与检测器共享 contextIntervalMs 配置） */
    let contextFrames: Array<{ data: Buffer; timestamp: number }> = [];
    if (this.recorder && this.config.contextIntervalMs > 0) {
      contextFrames = this.recorder.getContextFrames(cameraId, timestamp, this.config.contextIntervalMs);
    }
    const hasContext = contextFrames.length > 0;

    /** 构建 user content：当前帧 + 上下文帧 */
    const imageDataUrl = await resizeImage(jpeg);
    const userContent: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
      { type: "text", text: hasContext ? "Latest frame:" : "Analyze this surveillance camera image:" },
      { type: "image_url", image_url: { url: imageDataUrl } },
    ];

    if (hasContext) {
      const ctxUrls = await Promise.all(contextFrames.map(f => resizeImage(f.data)));
      for (let i = 0; i < contextFrames.length; i++) {
        const agoSec = Math.round((timestamp - contextFrames[i]!.timestamp) / 1000);
        userContent.push({ type: "text", text: `${agoSec}s ago:` });
        userContent.push({ type: "image_url", image_url: { url: ctxUrls[i]! } });
      }
    }

    /** 选择 prompt：有上下文帧时使用多帧分析 prompt */
    const basePrompt = this.config.systemPrompt || (hasContext ? MULTI_FRAME_SYSTEM_PROMPT : DEFAULT_SYSTEM_PROMPT);

    /** 构建 OpenAI 兼容请求 */
    const body = {
      model: this.config.model,
      messages: [
        { role: "system" as const, content: basePrompt },
        {
          role: "user" as const,
          content: userContent,
        },
      ],
      max_tokens: this.config.maxTokens,
      temperature: 0.3,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    const apiUrl = this.config.apiUrl.endsWith("/chat/completions")
      ? this.config.apiUrl
      : `${this.config.apiUrl.replace(/\/$/, "")}/v1/chat/completions`;

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

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

    aiMetrics.record({ source: "scene", inferMs, ok: true });

    const sceneResult: LlmSceneResult = {
      cameraId,
      timestamp,
      description,
      trigger,
      inferMs,
    };

    /** 场景描述去重：与上次描述相似度 > 80% 时跳过推送（减少重复信息） */
    const last = this.lastDescription.get(cameraId);
    if (last && description.length > 10 && last.length > 10) {
      const shorter = last.length < description.length ? last : description;
      const longer = last.length < description.length ? description : last;
      let matchChars = 0;
      for (let i = 0; i < shorter.length; i++) {
        if (shorter[i] === longer[i]) matchChars++;
      }
      const similarity = matchChars / shorter.length;
      if (similarity > 0.8) return;
    }
    this.lastDescription.set(cameraId, description);

    this.eventBus.emit("llm:scene" as keyof import("@/event-bus").EventPayloads, sceneResult as never);
    console.debug(`[MultimodalAnalyzer] ${cameraId}: "${description.slice(0, 80)}" (${Math.round(inferMs)}ms)`);
  }
}
