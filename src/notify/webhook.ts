import { type EventBus, type EventName } from "@/event-bus";
import { type RuntimeConfig } from "@/runtime-config";

/** Webhook 推送载荷 */
interface WebhookPayload {
  /** 事件类型 */
  event: EventName;
  /** 摄像头 ID */
  cameraId: string;
  /** 事件时间戳 */
  timestamp: number;
  /** 事件详情 */
  detail: Record<string, unknown>;
}

/**
 * Webhook 推送器
 * 监听检测/变动/摄像头状态事件，POST JSON 到配置的 Webhook URL
 */
export class WebhookNotifier {
  /** 要推送的事件类型 */
  private static readonly EVENTS: EventName[] = ["motion", "detect", "camera:online", "camera:offline", "alert"];

  constructor(
    private runtimeConfig: RuntimeConfig,
    private eventBus: EventBus,
  ) {}

  /** 启动监听 */
  start(): void {
    for (const event of WebhookNotifier.EVENTS) {
      this.eventBus.on(event, (payload) => {
        this.handleEvent(event, payload);
      });
    }
    console.log("[Webhook] 已启动");
  }

  /** 处理事件：构建载荷并推送到所有 Webhook URL */
  private handleEvent(event: EventName, payload: Record<string, unknown>): void {
    const urls = this.runtimeConfig.get().webhook?.urls;
    if (!urls || urls.length === 0) return;

    /** 构建精简载荷，不含二进制数据 */
    const webhookPayload = this.buildPayload(event, payload);

    for (const url of urls) {
      this.sendWebhook(url, webhookPayload);
    }
  }

  /** 构建 Webhook 载荷 */
  private buildPayload(event: EventName, payload: Record<string, unknown>): WebhookPayload {
    const cameraId = (payload.cameraId as string) ?? "";
    const timestamp = (payload.timestamp as number) ?? Date.now();

    const detail: Record<string, unknown> = {};

    if (event === "motion") {
      detail.ratio = payload.ratio;
    } else if (event === "detect") {
      const detections = payload.detections as Array<{ label: string; score: number }> | undefined;
      detail.detections = detections?.map(d => ({ label: d.label, score: d.score }));
      detail.count = detections?.length ?? 0;
    } else if (event === "alert") {
      detail.ruleId = payload.ruleId;
      detail.ruleName = payload.ruleName;
    }

    return { event, cameraId, timestamp, detail };
  }

  /** 异步发送 Webhook（fire-and-forget，不阻塞事件处理） */
  private sendWebhook(url: string, payload: WebhookPayload): void {
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch((err) => {
      console.error(`[Webhook] 推送失败 ${url}:`, (err as Error).message);
    });
  }
}
