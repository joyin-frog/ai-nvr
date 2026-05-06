/** 多模态消息内容 */
export type LlmMessageContent =
  | string
  | Array<{ type: string; text?: string; image_url?: { url: string } }>;

/** LLM 聊天补全请求参数 */
export interface LlmChatParams {
  /** API 端点 URL（OpenAI 兼容） */
  apiUrl: string;
  /** 模型名称 */
  model: string;
  /** 消息列表 */
  messages: Array<{ role: "system" | "user" | "assistant"; content: LlmMessageContent }>;
  /** 生成最大 token 数 */
  maxTokens?: number;
  /** 温度 */
  temperature?: number;
  /** 超时毫秒（默认 10_000） */
  timeoutMs?: number;
}

/**
 * 调用 OpenAI 兼容的 chat/completions API
 * API 错误时 throw，空内容时返回 null
 */
export async function callLlmChat(params: LlmChatParams): Promise<string | null> {
  const { apiUrl, model, messages, maxTokens, temperature, timeoutMs } = params;

  const endpoint = apiUrl.endsWith("/chat/completions")
    ? apiUrl
    : `${apiUrl.replace(/\/$/, "")}/v1/chat/completions`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs ?? 10_000);

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens ?? 200,
      temperature: temperature ?? 0.3,
    }),
    signal: controller.signal,
  }).finally(() => clearTimeout(timeout));

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`LLM API ${response.status}: ${text.slice(0, 200)}`);
  }

  const result = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  return result.choices?.[0]?.message?.content?.trim() ?? null;
}
