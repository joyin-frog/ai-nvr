import { createHmac } from "node:crypto";
import { type EventBus, type EventName } from "@/event-bus";
import { type RuntimeConfig } from "@/runtime-config";

/** 钉钉机器人 markdown 消息请求体 */
interface DingTalkMessage {
  /** 消息类型，固定 markdown */
  msgtype: "markdown";
  markdown: {
    /** 首屏展示标题 */
    title: string;
    /** markdown 格式正文 */
    text: string;
  };
}

/** 事件类型中文映射 */
const EVENT_LABELS: Record<string, string> = {
  motion: "画面变动",
  detect: "AI 检测",
  "camera:online": "摄像头上线",
  "camera:offline": "摄像头离线",
  alert: "告警触发",
  "track:appeared": "目标出现",
  "track:disappeared": "目标消失",
  "track:enter-zone": "进入区域",
  "track:leave-zone": "离开区域",
  "track:dwell": "区域停留",
  "track:speed": "高速移动",
};

/** 需要推送的事件类型 */
const PUSH_EVENTS: EventName[] = ["motion", "detect", "camera:offline", "alert", "track:appeared", "track:disappeared", "track:enter-zone", "track:leave-zone", "track:dwell", "track:speed"];

/**
 * 钉钉机器人通知推送
 * 监听告警/检测事件，通过钉钉自定义机器人 Webhook 推送 markdown 消息
 */
export class DingTalkNotifier {
  constructor(
    private runtimeConfig: RuntimeConfig,
    private eventBus: EventBus,
  ) {}

  /** 启动监听 */
  start(): void {
    for (const event of PUSH_EVENTS) {
      this.eventBus.on(event, (payload) => {
        this.handleEvent(event, payload);
      });
    }
    console.log("[DingTalk] 钉钉通知已启动");
  }

  /** 处理事件 */
  private handleEvent(event: EventName, payload: Record<string, unknown>): void {
    const config = this.runtimeConfig.get().notify?.dingtalk;
    if (!config?.enabled || !config.webhookUrl) return;

    const message = this.buildMessage(event, payload);
    this.send(config.webhookUrl, config.secret, message);
  }

  /** 构建钉钉 markdown 消息 */
  private buildMessage(event: EventName, payload: Record<string, unknown>): DingTalkMessage {
    const cameraId = (payload.cameraId as string) ?? "";
    const timestamp = (payload.timestamp as number) ?? Date.now();
    const time = new Date(timestamp).toLocaleString("zh-CN");
    const label = EVENT_LABELS[event] ?? event;

    let body = "";

    if (event === "motion") {
      const ratio = payload.ratio as number | undefined;
      body = ratio !== undefined ? `变动比例: ${(ratio * 100).toFixed(1)}%` : "";
    } else if (event === "detect") {
      const detections = payload.detections as Array<{ label: string; score: number; trackId?: number; trackName?: string }> | undefined;
      if (detections && detections.length > 0) {
        body = "检测目标:\n" + detections.map(d => {
          const name = d.trackName || d.label;
          const id = d.trackId ? ` #${d.trackId}` : "";
          return `- ${name}${id} (${(d.score * 100).toFixed(0)}%)`;
        }).join("\n");
      }
    } else if (event === "alert") {
      const ruleName = payload.ruleName as string | undefined;
      const detail = payload.detail as string | undefined;
      body = `规则: ${ruleName ?? ""}`;
      if (detail) body += `\n${detail}`;
    } else if (event === "camera:offline") {
      body = "摄像头已断开连接";
    } else if (event === "track:appeared") {
      const trackLabel = payload.label as string | undefined;
      const trackName = payload.trackName as string | undefined;
      const trackId = payload.trackId as number | undefined;
      const score = payload.score as number | undefined;
      const displayName = trackName ?? trackLabel ?? "目标";
      body = `${displayName} #${trackId ?? "?"}${score ? ` (${(score * 100).toFixed(0)}%)` : ""}`;
    } else if (event === "track:disappeared") {
      const trackLabel = payload.label as string | undefined;
      const trackName = payload.trackName as string | undefined;
      const trackId = payload.trackId as number | undefined;
      const displayName = trackName ?? trackLabel ?? "目标";
      body = `${displayName} #${trackId ?? "?"}`;
    } else if (event === "track:enter-zone" || event === "track:leave-zone") {
      const trackLabel = payload.label as string | undefined;
      const trackName = payload.trackName as string | undefined;
      const trackId = payload.trackId as number | undefined;
      const zoneName = payload.zoneName as string | undefined;
      const displayName = trackName ?? trackLabel ?? "目标";
      const arrow = event === "track:enter-zone" ? "→" : "←";
      body = `${displayName} #${trackId ?? "?"} ${arrow} ${zoneName ?? "?"}`;
    } else if (event === "track:dwell") {
      const trackLabel = payload.label as string | undefined;
      const trackName = payload.trackName as string | undefined;
      const trackId = payload.trackId as number | undefined;
      const zoneName = payload.zoneName as string | undefined;
      const dwellMs = payload.dwellMs as number | undefined;
      const displayName = trackName ?? trackLabel ?? "目标";
      body = `${displayName} #${trackId ?? "?"} 在 ${zoneName ?? "?"} 停留 ${dwellMs ? `${(dwellMs / 1000).toFixed(0)}s` : "?"}`;
    } else if (event === "track:speed") {
      const trackLabel = payload.label as string | undefined;
      const trackName = payload.trackName as string | undefined;
      const trackId = payload.trackId as number | undefined;
      const speed = payload.speed as number | undefined;
      const displayName = trackName ?? trackLabel ?? "目标";
      body = `${displayName} #${trackId ?? "?"} 高速移动 (${speed?.toFixed(3) ?? "?"}/帧)`;
    }

    const title = `JK NVR - ${label}`;
    const text = `### ${label}\n\n` +
      `- 摄像头: ${cameraId}\n` +
      `- 时间: ${time}\n` +
      (body ? `\n${body}` : "");

    return { msgtype: "markdown", markdown: { title, text } };
  }

  /** 异步发送钉钉消息（fire-and-forget） */
  private send(webhookUrl: string, secret: string | undefined, message: DingTalkMessage): void {
    const url = secret ? this.signUrl(webhookUrl, secret) : webhookUrl;

    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    }).then((res) => {
      if (!res.ok) {
        console.error(`[DingTalk] 推送失败 HTTP ${res.status}`);
      }
    }).catch((err) => {
      console.error(`[DingTalk] 推送失败:`, (err as Error).message);
    });
  }

  /** 对 Webhook URL 进行加签（HmacSHA256 + timestamp） */
  private signUrl(webhookUrl: string, secret: string): string {
    const timestamp = Date.now();
    const stringToSign = `${timestamp}\n${secret}`;
    const hmac = createHmac("sha256", secret);
    hmac.update(stringToSign);
    const sign = encodeURIComponent(hmac.digest("base64"));
    return `${webhookUrl}&timestamp=${timestamp}&sign=${sign}`;
  }
}
