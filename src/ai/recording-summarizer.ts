import { type EventBus } from "@/event-bus";
import { type EventStorage } from "@/storage/events";
import { type RuntimeConfig } from "@/runtime-config";
import { aiMetrics } from "./metrics";
import { resolveModel } from "./multimodal-analyzer";

/** 录像 AI 摘要结果 */
export interface RecordingSummary {
  /** 摄像头 ID */
  cameraId: string;
  /** 录像文件名 */
  filename: string;
  /** 摘要文本 */
  summary: string;
  /** 涵盖的事件数量 */
  eventCount: number;
  /** 录像时长 ms */
  durationMs: number;
  /** 生成耗时 ms */
  inferMs: number;
}

/**
 * 录像 AI 摘要生成器
 * 录像完成时，查询该时间段内的事件，用 LLM 生成摘要
 */
export class RecordingSummarizer {
  private eventBus: EventBus;
  private eventStorage: EventStorage;
  private runtimeConfig: RuntimeConfig;
  private unsub: (() => void) | null = null;
  /** 正在生成中的录像（防重复） */
  private generating = new Set<string>();

  constructor(eventBus: EventBus, eventStorage: EventStorage, runtimeConfig: RuntimeConfig) {
    this.eventBus = eventBus;
    this.eventStorage = eventStorage;
    this.runtimeConfig = runtimeConfig;
  }

  start(): void {
    this.unsub = this.eventBus.on("recording:completed", (payload) => {
      this.generateSummary(payload.cameraId, payload.filename, payload.startTime, payload.endTime).catch((err) => {
        console.warn("[RecordingSummarizer] generateSummary failed:", err instanceof Error ? err.message : String(err));
      });
    });
  }

  stop(): void {
    if (this.unsub) { this.unsub(); this.unsub = null; }
    this.generating.clear();
  }

  private async generateSummary(cameraId: string, filename: string, startTime: number, endTime: number): Promise<void> {
    const key = `${cameraId}:${filename}`;
    if (this.generating.has(key)) return;

    const aiCfg = this.runtimeConfig.get().ai;
    const resolved = resolveModel(aiCfg.models, aiCfg.llm);
    if (!aiCfg.llm.enabled || !resolved.apiUrl || !resolved.model) return;

    /** 查询录像期间的事件 */
    const events = this.eventStorage.query({
      cameraId,
      since: startTime,
      until: endTime,
      limit: 50,
    });

    /** 过滤掉 motion 和太多噪声 */
    const filtered = events.filter(e => e.type !== "motion");
    if (filtered.length < 2) return;

    this.generating.add(key);
    const t0 = performance.now();

    try {
      const durationSec = Math.round((endTime - startTime) / 1000);
      const lang = this.runtimeConfig.get().language;
      const langInstruction = lang.startsWith("zh") ? "Write in Chinese." : "Write in English.";

      /** 按类型聚合事件 */
      const typeCounts: Record<string, number> = {};
      const detailLines: string[] = [];
      for (const e of filtered) {
        typeCounts[e.type] = (typeCounts[e.type] ?? 0) + 1;
        if (e.detail && detailLines.length < 20) {
          const time = new Date(e.timestamp).toLocaleTimeString();
          detailLines.push(`[${time}] ${e.type}: ${e.detail.slice(0, 80)}`);
        }
      }
      const typeSummary = Object.entries(typeCounts).map(([t, c]) => `${t}(${c})`).join(", ");

      const systemPrompt = `Summarize this surveillance recording. Max 2 sentences. Be factual. ${langInstruction}`;

      const body = {
        model: resolved.model,
        messages: [
          { role: "system" as const, content: systemPrompt },
          {
            role: "user" as const,
            content: `Recording: ${durationSec}s, camera ${cameraId}\nEvents: ${typeSummary}\nDetails:\n${detailLines.join("\n")}`,
          },
        ],
        max_tokens: 150,
        temperature: 0.2,
      };

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      const apiUrl = resolved.apiUrl.endsWith("/chat/completions")
        ? resolved.apiUrl
        : `${resolved.apiUrl.replace(/\/$/, "")}/v1/chat/completions`;
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout));

      if (!response.ok) return;

      const result = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const summaryText = result.choices?.[0]?.message?.content?.trim();
      if (!summaryText) return;

      const inferMs = performance.now() - t0;

      aiMetrics.record({ source: "recording", inferMs, ok: true });

      const summary: RecordingSummary = {
        cameraId,
        filename,
        summary: summaryText,
        eventCount: filtered.length,
        durationMs: endTime - startTime,
        inferMs,
      };

      /** 持久化 */
      this.eventStorage.insert("llm:recording-summary", cameraId, Date.now(), JSON.stringify(summary));

      console.log(`[RecordingSummarizer] ${cameraId} 录像摘要 (${durationSec}s, ${filtered.length}事件, ${Math.round(inferMs)}ms): ${summaryText.slice(0, 60)}...`);
    } catch (err) {
      console.warn("[RecordingSummarizer] 摘要生成失败:", err instanceof Error ? err.message : String(err));
    } finally {
      this.generating.delete(key);
    }
  }
}
