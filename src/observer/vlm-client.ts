import { type ObservationResult, type Region } from "@/observer/types";
import { resolveModel } from "@/ai/multimodal-analyzer";
import { type RuntimeConfig } from "@/runtime-config";

/** 解析后的模型配置 */
interface ResolvedModelConfig {
  apiUrl: string;
  model: string;
  maxTokens: number;
}

/**
 * VLM 客户端
 * 负责 API 调用、结果解析、超时保护
 */
export class VlmClient {
  constructor(private runtimeConfig: RuntimeConfig) {}

  /** 解析模型配置 */
  resolveModelConfig(modelId?: string): ResolvedModelConfig | null {
    const aiCfg = this.runtimeConfig.get().ai;
    const llmConfig = aiCfg.llm;
    if (!llmConfig.enabled) return null;

    const resolved = resolveModel(aiCfg.models, llmConfig, modelId || undefined);
    if (!resolved.apiUrl || !resolved.model) return null;

    return {
      apiUrl: resolved.apiUrl,
      model: resolved.model,
      maxTokens: resolved.maxTokens,
    };
  }

  /** 调用 VLM API */
  async call(
    modelConfig: ResolvedModelConfig,
    systemPrompt: string,
    userContent: Array<{ type: string; text?: string; image_url?: { url: string } }>,
    maxTokensOverride?: number,
  ): Promise<ObservationResult> {
    const body = {
      model: modelConfig.model,
      messages: [
        { role: "system" as const, content: systemPrompt },
        { role: "user" as const, content: userContent },
      ],
      max_tokens: maxTokensOverride ?? (modelConfig.maxTokens > 0 ? modelConfig.maxTokens : 200),
      temperature: 0.1,
    };

    /** 15 秒超时保护 */
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    const apiUrl = modelConfig.apiUrl.endsWith("/chat/completions")
      ? modelConfig.apiUrl
      : `${modelConfig.apiUrl.replace(/\/$/, "")}/v1/chat/completions`;

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`VLM API ${response.status}: ${text.slice(0, 100)}`);
    }

    const result = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = result.choices?.[0]?.message?.content?.trim() ?? "";
    if (!content) throw new Error("VLM returned empty content");

    return this.parseResponse(content);
  }

  /** 解析 VLM 返回的 JSON 结果 */
  parseResponse(content: string): ObservationResult {
    const result = this.doParse(content);
    result.rawContent = content;
    return result;
  }

  private doParse(content: string): ObservationResult {
    /** 从第一个 { 开始匹配括号平衡，避免贪婪匹配跨 JSON 合并 */
    const startIdx = content.indexOf("{");
    if (startIdx >= 0) {
      let depth = 0;
      let endIdx = -1;
      for (let i = startIdx; i < content.length; i++) {
        if (content[i] === "{") depth++;
        else if (content[i] === "}") depth--;
        if (depth === 0) { endIdx = i; break; }
      }
      if (endIdx >= 0) {
        const jsonStr = content.slice(startIdx, endIdx + 1);
        try {
          const obj = JSON.parse(jsonStr) as Record<string, unknown>;
          const signalUpdates = Array.isArray(obj.states)
            ? (obj.states as Array<Record<string, unknown>>).map(s => ({
              id: typeof s.id === "number" ? s.id : 0,
              value: typeof s.value === "string" ? s.value : String(s.value),
            })).filter(s => s.id > 0)
            : undefined;

          const regions = this.parseRegions(obj.regions);

          return {
            matched: obj.matched === true,
            confidence: typeof obj.confidence === "number" ? obj.confidence : 0.5,
            description: typeof obj.description === "string" ? obj.description : content,
            signalUpdates,
            regions: regions.length > 0 ? regions : undefined,
          };
        } catch (e) {
          console.warn("[VLM] 响应解析失败:", e);
          /** JSON 解析失败，走 fallback */
        }
      }
    }

    /** Fallback: 关键词匹配 */
    const lower = content.toLowerCase();
    const matched = lower.includes("matched\": true") || lower.includes("matched\":true") ||
      (lower.includes("matched") && !lower.includes("matched\": false") && !lower.includes("matched\":false"));
    return { matched, confidence: 0.3, description: content };
  }

  /** 解析目标区域坐标 */
  private parseRegions(raw: unknown): Region[] {
    if (!Array.isArray(raw)) return [];
    const result: Region[] = [];
    for (const item of raw as Array<Record<string, unknown>>) {
      const label = typeof item.label === "string" ? item.label : "unknown";
      const box = item.box;
      let xmin: number | undefined, ymin: number | undefined, xmax: number | undefined, ymax: number | undefined;

      if (Array.isArray(box) && box.length >= 4) {
        xmin = this.clamp01(Number(box[0]));
        ymin = this.clamp01(Number(box[1]));
        xmax = this.clamp01(Number(box[2]));
        ymax = this.clamp01(Number(box[3]));
      } else if (box && typeof box === "object" && !Array.isArray(box)) {
        const b = box as Record<string, unknown>;
        xmin = this.clamp01(Number(b.xmin ?? b.x1 ?? 0));
        ymin = this.clamp01(Number(b.ymin ?? b.y1 ?? 0));
        xmax = this.clamp01(Number(b.xmax ?? b.x2 ?? 0));
        ymax = this.clamp01(Number(b.ymax ?? b.y2 ?? 0));
      }

      if (xmin !== undefined && ymin !== undefined && xmax !== undefined && ymax !== undefined && xmax > xmin && ymax > ymin) {
        result.push({ label, box: { xmin, ymin, xmax, ymax } });
      }
    }
    return result;
  }

  /** 坐标 clamp 到 [0, 1] */
  private clamp01(v: number): number {
    return Math.max(0, Math.min(1, v));
  }
}
