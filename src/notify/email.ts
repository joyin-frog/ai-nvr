import nodemailer from "nodemailer";
import { type EventBus, type EventName } from "@/event-bus";
import { type RuntimeConfig, type EmailConfig } from "@/runtime-config";

/** 事件类型中文映射 */
const EVENT_LABELS: Record<string, string> = {
  motion: "画面变动",
  detect: "AI 检测",
  "camera:online": "摄像头上线",
  "camera:offline": "摄像头离线",
  alert: "告警触发",
  "detect:rule": "规则检测",
  "track:appeared": "目标出现",
  "track:disappeared": "目标消失",
  "track:enter-zone": "进入区域",
  "track:leave-zone": "离开区域",
  "track:dwell": "区域停留",
  "track:speed": "高速移动",
};

/** 事件类型对应 CSS 颜色 */
const EVENT_COLORS: Record<string, string> = {
  motion: "#f0ad4e",
  detect: "#5bc0de",
  "camera:online": "#5cb85c",
  "camera:offline": "#d9534f",
  alert: "#d9534f",
  "track:appeared": "#5cb85c",
  "track:disappeared": "#777",
  "track:enter-zone": "#26A69A",
  "track:leave-zone": "#7E57C2",
  "track:dwell": "#FF7043",
  "track:speed": "#E91E63",
};

/** 需要推送的事件类型 */
const PUSH_EVENTS: EventName[] = ["motion", "detect", "camera:offline", "detect:rule", "track:appeared", "track:disappeared", "track:enter-zone", "track:leave-zone", "track:dwell", "track:speed"];

/**
 * 邮件告警通知
 * 监听告警/检测事件，通过 SMTP 发送 HTML 邮件
 */
export class EmailNotifier {
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
    console.log("[Email] 邮件通知已启动");
  }

  /** 处理事件 */
  private handleEvent(event: EventName, payload: Record<string, unknown>): void {
    const config = this.runtimeConfig.get().notify?.email;
    if (!config?.enabled || !config.smtp) return;

    const mail = this.buildMail(event, payload);
    this.send({ smtp: config.smtp, from: config.from, to: config.to }, mail);
  }

  /** 构建邮件内容 */
  private buildMail(event: EventName, payload: Record<string, unknown>): { subject: string; html: string } {
    const cameraId = (payload.cameraId as string) ?? "";
    const timestamp = (payload.timestamp as number) ?? Date.now();
    const time = new Date(timestamp).toLocaleString("zh-CN");
    const label = EVENT_LABELS[event] ?? event;
    const color = EVENT_COLORS[event] ?? "#333";

    let detailHtml = "";

    if (event === "motion") {
      const ratio = payload.ratio as number | undefined;
      detailHtml = ratio !== undefined
        ? `<tr><td>变动比例</td><td><strong>${(ratio * 100).toFixed(1)}%</strong></td></tr>`
        : "";
    } else if (event === "detect") {
      const detections = payload.detections as Array<{ label: string; score: number; trackName?: string; semanticLabel?: string }> | undefined;
      if (detections && detections.length > 0) {
        const rows = detections.map(d =>
          `<tr><td>${d.trackName || d.semanticLabel || d.label}</td><td>${(d.score * 100).toFixed(0)}%</td></tr>`,
        ).join("");
        detailHtml = `<tr><td colspan="2"><strong>检测目标</strong></td></tr>${rows}`;
      }
    } else if (event === "detect:rule") {
      const ruleName = payload.ruleName as string | undefined;
      const prompt = payload.prompt as string | undefined;
      const result = payload.result as string | undefined;
      const confidence = payload.confidence as number | undefined;
      detailHtml = `<tr><td>检测规则</td><td>${ruleName ?? ""}</td></tr>`;
      if (prompt) detailHtml += `<tr><td>提示词</td><td>${prompt}</td></tr>`;
      if (result) detailHtml += `<tr><td>AI 结果</td><td>${result}${confidence !== undefined ? ` (${(confidence * 100).toFixed(0)}%)` : ""}</td></tr>`;
    } else if (event === "camera:offline") {
      detailHtml = `<tr><td>状态</td><td style="color:#d9534f">已断开连接</td></tr>`;
    } else if (event === "track:appeared") {
      const trackLabel = payload.label as string | undefined;
      const trackName = payload.trackName as string | undefined;
      const semanticLabel = payload.semanticLabel as string | undefined;
      const trackId = payload.trackId as number | undefined;
      const score = payload.score as number | undefined;
      const displayName = trackName ?? semanticLabel ?? trackLabel ?? "未知";
      detailHtml = `<tr><td>目标</td><td><strong>${displayName} #${trackId ?? "?"}</strong>${score ? ` (${(score * 100).toFixed(0)}%)` : ""}</td></tr>`;
    } else if (event === "track:disappeared") {
      const trackLabel = payload.label as string | undefined;
      const trackName = payload.trackName as string | undefined;
      const semanticLabel = payload.semanticLabel as string | undefined;
      const trackId = payload.trackId as number | undefined;
      const displayName = trackName ?? semanticLabel ?? trackLabel ?? "未知";
      detailHtml = `<tr><td>目标</td><td>${displayName} #${trackId ?? "?"}</td></tr>`;
    } else if (event === "track:enter-zone" || event === "track:leave-zone") {
      const trackLabel = payload.label as string | undefined;
      const trackName = payload.trackName as string | undefined;
      const semanticLabel = payload.semanticLabel as string | undefined;
      const trackId = payload.trackId as number | undefined;
      const zoneName = payload.zoneName as string | undefined;
      const displayName = trackName ?? semanticLabel ?? trackLabel ?? "未知";
      const arrow = event === "track:enter-zone" ? "→" : "←";
      detailHtml = `<tr><td>目标</td><td>${displayName} #${trackId ?? "?"} ${arrow} ${zoneName ?? "?"}</td></tr>`;
    } else if (event === "track:dwell") {
      const trackLabel = payload.label as string | undefined;
      const trackName = payload.trackName as string | undefined;
      const semanticLabel = payload.semanticLabel as string | undefined;
      const trackId = payload.trackId as number | undefined;
      const zoneName = payload.zoneName as string | undefined;
      const dwellMs = payload.dwellMs as number | undefined;
      const displayName = trackName ?? semanticLabel ?? trackLabel ?? "未知";
      detailHtml = `<tr><td>目标</td><td>${displayName} #${trackId ?? "?"} 在 ${zoneName ?? "?"} 停留 ${dwellMs ? `${(dwellMs / 1000).toFixed(0)}s` : "?"}</td></tr>`;
    } else if (event === "track:speed") {
      const trackLabel = payload.label as string | undefined;
      const trackName = payload.trackName as string | undefined;
      const semanticLabel = payload.semanticLabel as string | undefined;
      const trackId = payload.trackId as number | undefined;
      const speed = payload.speed as number | undefined;
      const displayName = trackName ?? semanticLabel ?? trackLabel ?? "未知";
      detailHtml = `<tr><td>目标</td><td>${displayName} #${trackId ?? "?"} 高速移动 (${speed?.toFixed(3) ?? "?"}/帧)</td></tr>`;
    }

    const subject = `[JK NVR] ${label} - ${cameraId}`;
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;border:1px solid #ddd;border-radius:8px;overflow:hidden">
        <div style="background:${color};color:#fff;padding:12px 16px;font-size:16px;font-weight:bold">${label}</div>
        <table style="width:100%;border-collapse:collapse;padding:0 16px">
          <tr><td style="padding:8px 16px;color:#888;width:80px">摄像头</td><td style="padding:8px 16px">${cameraId}</td></tr>
          <tr><td style="padding:8px 16px;color:#888">时间</td><td style="padding:8px 16px">${time}</td></tr>
          ${detailHtml}
        </table>
        <div style="padding:12px 16px;background:#f5f5f5;font-size:12px;color:#999;text-align:center">JK NVR 监控系统</div>
      </div>`;

    return { subject, html };
  }

  /** 异步发送邮件（fire-and-forget） */
  private send(config: { smtp: NonNullable<EmailConfig["smtp"]>; from: string; to: string }, mail: { subject: string; html: string }): void {
    const transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: {
        user: config.smtp.user,
        pass: config.smtp.pass,
      },
    });

    transporter.sendMail({
      from: config.from || `"JK NVR" <${config.smtp.user}>`,
      to: config.to,
      subject: mail.subject,
      html: mail.html,
    }).then((info) => {
      console.log(`[Email] 邮件已发送: ${info.messageId}`);
    }).catch((err) => {
      console.error(`[Email] 发送失败:`, (err as Error).message);
    }).finally(() => {
      transporter.close();
    });
  }
}
