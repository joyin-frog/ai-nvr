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
  private static readonly EVENTS: EventName[] = ["motion", "detect", "camera:online", "camera:offline", "detect:rule", "alert", "track:appeared", "track:disappeared", "track:enter-zone", "track:leave-zone", "track:dwell", "track:speed", "state:changed", "llm:scene", "llm:patrol"];

  /** 去抖：同一事件+摄像头在窗口内只推送一次 */
  private recentKeys = new Map<string, number>();
  private static readonly DEDUP_WINDOW_MS = 60_000;

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
    /** state:changed 事件只在 notify=true 时推送 */
    if (event === "state:changed" && !payload.notify) return;

    /** 去抖：高频事件（track:*、detect）同一摄像头 60s 内只推一次 */
    const cameraId = (payload.cameraId as string) ?? "";
    const dedupKey = `${event}:${cameraId}`;
    const now = Date.now();
    const lastSent = this.recentKeys.get(dedupKey);
    const isHighFreq = event.startsWith("track:") || event === "detect" || event === "motion";
    if (isHighFreq && lastSent && now - lastSent < WebhookNotifier.DEDUP_WINDOW_MS) return;
    if (isHighFreq) this.recentKeys.set(dedupKey, now);

    /** 清理过期去重记录 */
    if (this.recentKeys.size > 500) {
      for (const [key, ts] of this.recentKeys) {
        if (now - ts > WebhookNotifier.DEDUP_WINDOW_MS) this.recentKeys.delete(key);
      }
    }

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
      const detections = payload.detections as Array<{ label: string; score: number; box?: { xmin: number; ymin: number; xmax: number; ymax: number }; trackId?: number; trackName?: string; semanticLabel?: string }> | undefined;
      detail.detections = detections?.map(d => ({ label: d.label, score: d.score, box: d.box, trackId: d.trackId, trackName: d.trackName, semanticLabel: d.semanticLabel }));
      detail.count = detections?.length ?? 0;
      /** 附带标注快照 URL（供外部系统展示） */
      detail.snapshotUrl = `/api/detection/annotated/${cameraId}`;
      detail.frameUrl = `/api/snapshot/${cameraId}`;
    } else if (event === "detect:rule") {
      detail.ruleId = payload.ruleId;
      detail.ruleName = payload.ruleName;
      detail.prompt = payload.prompt;
      detail.result = payload.result;
      detail.confidence = payload.confidence;
    } else if (event === "alert") {
      detail.ruleId = payload.ruleId;
      detail.ruleName = payload.ruleName;
      detail.triggerDetail = payload.detail;
    } else if (event === "track:appeared") {
      detail.label = payload.label;
      detail.trackId = payload.trackId;
      detail.score = payload.score;
      detail.trackName = payload.trackName;
      if (payload.semanticLabel) detail.semanticLabel = payload.semanticLabel;
    } else if (event === "track:disappeared") {
      detail.label = payload.label;
      detail.trackId = payload.trackId;
      detail.trackName = payload.trackName;
      if (payload.semanticLabel) detail.semanticLabel = payload.semanticLabel;
    } else if (event === "track:enter-zone" || event === "track:leave-zone") {
      detail.label = payload.label;
      detail.trackId = payload.trackId;
      detail.trackName = payload.trackName;
      if (payload.semanticLabel) detail.semanticLabel = payload.semanticLabel;
      detail.zoneId = payload.zoneId;
      detail.zoneName = payload.zoneName;
      if (payload.dwellMs !== undefined) detail.dwellMs = payload.dwellMs;
    } else if (event === "track:dwell") {
      detail.label = payload.label;
      detail.trackId = payload.trackId;
      detail.trackName = payload.trackName;
      if (payload.semanticLabel) detail.semanticLabel = payload.semanticLabel;
      detail.zoneId = payload.zoneId;
      detail.zoneName = payload.zoneName;
      detail.dwellMs = payload.dwellMs;
    } else if (event === "track:speed") {
      detail.label = payload.label;
      detail.trackId = payload.trackId;
      detail.trackName = payload.trackName;
      if (payload.semanticLabel) detail.semanticLabel = payload.semanticLabel;
      detail.speed = payload.speed;
    } else if (event === "state:changed") {
      detail.stateId = payload.stateId;
      detail.stateName = payload.stateName;
      detail.oldValue = payload.oldValue;
      detail.newValue = payload.newValue;
      detail.source = payload.source;
      if (payload.sourceRuleId) detail.sourceRuleId = payload.sourceRuleId;
    } else if (event === "llm:scene") {
      detail.description = payload.description;
      detail.trigger = payload.trigger;
      detail.inferMs = payload.inferMs;
    } else if (event === "llm:patrol") {
      detail.analysis = payload.analysis;
      detail.hasAnomaly = payload.hasAnomaly;
      detail.anomalyDetail = payload.anomalyDetail;
      detail.count = payload.count;
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
