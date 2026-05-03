import { type EventBus } from "@/event-bus";
import { type EventStorage } from "@/storage/events";
import { type RuntimeConfig } from "@/runtime-config";

/** AI 事件摘要配置 */
export interface EventSummarizerConfig {
  /** 是否启用 */
  enabled: boolean;
  /** 摘要间隔（毫秒，默认 60000 = 1 分钟） */
  intervalMs: number;
  /** 回溯窗口（毫秒，默认取上一个 interval） */
  windowMs: number;
  /** 最大事件数（避免 token 过多） */
  maxEvents: number;
}

/** AI 事件摘要结果 */
export interface EventSummary {
  /** 摘要文本 */
  text: string;
  /** 涵盖的时间范围起始 */
  fromTime: number;
  /** 涵盖的时间范围结束 */
  toTime: number;
  /** 涵盖的事件数量 */
  eventCount: number;
  /** 生成耗时 ms */
  inferMs: number;
  [key: string]: unknown;
}

const DEFAULT_SUMMARY_PROMPT = `Summarize these surveillance events concisely. Focus on key activities, safety concerns, patterns. Max 3 sentences. Be factual.`;

/**
 * AI 事件摘要器
 * 定期查询近期事件，用 LLM 生成人类可读的摘要
 */
export class EventSummarizer {
  private eventBus: EventBus;
  private eventStorage: EventStorage;
  private runtimeConfig: RuntimeConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  /** 是否正在生成摘要 */
  private generating = false;

  constructor(
    eventBus: EventBus,
    eventStorage: EventStorage,
    runtimeConfig: RuntimeConfig,
  ) {
    this.eventBus = eventBus;
    this.eventStorage = eventStorage;
    this.runtimeConfig = runtimeConfig;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const config = this.getConfig();
    if (!config.enabled) return;

    this.timer = setInterval(() => this.generateSummary(), config.intervalMs);
    console.log(`[EventSummarizer] 已启动 (interval=${config.intervalMs}ms)`);
  }

  stop(): void {
    this.started = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.generating = false;
  }

  private getConfig(): EventSummarizerConfig {
    const ai = this.runtimeConfig.get().ai;
    const llm = ai.llm;
    return {
      enabled: llm.enabled && !!llm.apiUrl && !!llm.model,
      intervalMs: 60_000,
      windowMs: 60_000,
      maxEvents: 50,
    };
  }

  /** 生成摘要 */
  private async generateSummary(): Promise<void> {
    if (this.generating) return;
    const config = this.getConfig();
    if (!config.enabled) return;

    const llmConfig = this.runtimeConfig.get().ai.llm;
    const now = Date.now();
    const from = now - config.windowMs;

    /** 查询窗口内的事件（排除 motion 类型避免噪声） */
    const events = this.eventStorage.query({
      since: from,
      until: now,
      limit: config.maxEvents,
    });

    /** 过滤掉 motion 类型（太多、信息量低） */
    const filtered = events.filter(e => e.type !== "motion");
    if (filtered.length < 3) return;

    this.generating = true;
    const t0 = performance.now();

    try {
      /** 构建事件文本 */
      const lang = this.runtimeConfig.get().language;
      const langInstruction = lang.startsWith("zh") ? " IMPORTANT: Write the summary in Chinese (中文)." : "";

      const eventLines = filtered.map(e => {
        const time = new Date(e.timestamp).toLocaleTimeString();
        const detail = e.detail ? ` — ${e.detail.slice(0, 100)}` : "";
        return `[${time}] ${e.type} (${e.camera_id})${detail}`;
      }).reverse().join("\n");

      const systemPrompt = DEFAULT_SUMMARY_PROMPT + langInstruction;

      const body = {
        model: llmConfig.model,
        messages: [
          { role: "system" as const, content: systemPrompt },
          {
            role: "user" as const,
            content: `Events from the last ${Math.round(config.windowMs / 1000)}s:\n\n${eventLines}`,
          },
        ],
        max_tokens: 200,
        temperature: 0.3,
      };

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      const response = await fetch(llmConfig.apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout));

      if (!response.ok) return;

      const result = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
      };

      const text = result.choices?.[0]?.message?.content?.trim();
      if (!text) return;

      const inferMs = performance.now() - t0;

      const summary: EventSummary = {
        text,
        fromTime: from,
        toTime: now,
        eventCount: filtered.length,
        inferMs,
      };

      /** 写入事件存储（使摘要可在事件面板中回溯查询） */
      const detailJson = JSON.stringify(summary);
      this.eventStorage.insert("llm:summary", "", now, detailJson);

      this.eventBus.emit("llm:summary" as keyof import("@/event-bus").EventPayloads, summary as never);
      console.log(`[EventSummarizer] 摘要生成 (${filtered.length} 事件, ${Math.round(inferMs)}ms): ${text.slice(0, 60)}...`);
    } catch (err) {
      console.warn("[EventSummarizer] 摘要生成失败:", err instanceof Error ? err.message : String(err));
    } finally {
      this.generating = false;
    }
  }
}
