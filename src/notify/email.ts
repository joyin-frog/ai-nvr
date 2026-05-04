import nodemailer from "nodemailer";
import { type EventBus, type EventName } from "@/event-bus";
import { type RuntimeConfig, type EmailConfig } from "@/runtime-config";

/** HTML 实体转义（防止 XSS） */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 事件类型中文映射 */
const EVENT_LABELS: Record<string, string> = {
  motion: "画面变动",
  "camera:online": "摄像头上线",
  "camera:offline": "摄像头离线",
  alert: "告警触发",
  observation: "观测器检测",
  "track:appeared": "目标出现",
  "track:disappeared": "目标消失",
  "track:enter-zone": "进入区域",
  "track:leave-zone": "离开区域",
  "track:dwell": "区域停留",
  "track:speed": "高速移动",
  "signal:changed": "信号变更",
  "llm:patrol": "AI 巡逻报告",
};

/** 事件类型对应 CSS 颜色 */
const EVENT_COLORS: Record<string, string> = {
  motion: "#f0ad4e",
  "camera:online": "#5cb85c",
  "camera:offline": "#d9534f",
  alert: "#d9534f",
  observation: "#26A69A",
  "track:appeared": "#5cb85c",
  "track:disappeared": "#777",
  "track:enter-zone": "#26A69A",
  "track:leave-zone": "#7E57C2",
  "track:dwell": "#FF7043",
  "track:speed": "#E91E63",
  "signal:changed": "#9C27B0",
  "llm:patrol": "#7E57C2",
};

/** 需要推送的事件类型 */
const PUSH_EVENTS: EventName[] = ["motion", "camera:offline", "alert", "observation", "track:appeared", "track:disappeared", "track:enter-zone", "track:leave-zone", "track:dwell", "track:speed", "signal:changed", "llm:patrol"];

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
    /** signal:changed 事件只在 notify=true 时推送 */
    if (event === "signal:changed" && !payload.notify) return;
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
    } else if (event === "observation") {
      const observerName = payload.observerName as string | undefined;
      const prompt = payload.prompt as string | undefined;
      const result = payload.result as string | undefined;
      const confidence = payload.confidence as number | undefined;
      detailHtml = `<tr><td>观测器</td><td>${esc(observerName ?? "")}</td></tr>`;
      if (prompt) detailHtml += `<tr><td>提示词</td><td>${esc(prompt)}</td></tr>`;
      if (result) detailHtml += `<tr><td>AI 结果</td><td>${esc(result)}${confidence !== undefined ? ` (${(confidence * 100).toFixed(0)}%)` : ""}</td></tr>`;
    } else if (event === "camera:offline") {
      detailHtml = `<tr><td>状态</td><td style="color:#d9534f">已断开连接</td></tr>`;
    } else if (event === "alert") {
      const ruleName = payload.ruleName as string | undefined;
      const triggerDetail = payload.detail as string | undefined;
      detailHtml = `<tr><td>告警规则</td><td><strong>${esc(ruleName ?? "")}</strong></td></tr>`;
      if (triggerDetail) detailHtml += `<tr><td>触发详情</td><td>${esc(triggerDetail)}</td></tr>`;
    } else if (event === "track:appeared") {
      const trackLabel = payload.label as string | undefined;
      const trackName = payload.trackName as string | undefined;
      const semanticLabel = payload.semanticLabel as string | undefined;
      const trackId = payload.trackId as number | undefined;
      const score = payload.score as number | undefined;
      const displayName = esc(trackName ?? semanticLabel ?? trackLabel ?? "未知");
      detailHtml = `<tr><td>目标</td><td><strong>${displayName} #${trackId ?? "?"}</strong>${score ? ` (${(score * 100).toFixed(0)}%)` : ""}</td></tr>`;
    } else if (event === "track:disappeared") {
      const trackLabel = payload.label as string | undefined;
      const trackName = payload.trackName as string | undefined;
      const semanticLabel = payload.semanticLabel as string | undefined;
      const trackId = payload.trackId as number | undefined;
      const displayName = esc(trackName ?? semanticLabel ?? trackLabel ?? "未知");
      detailHtml = `<tr><td>目标</td><td>${displayName} #${trackId ?? "?"}</td></tr>`;
    } else if (event === "track:enter-zone" || event === "track:leave-zone") {
      const trackLabel = payload.label as string | undefined;
      const trackName = payload.trackName as string | undefined;
      const semanticLabel = payload.semanticLabel as string | undefined;
      const trackId = payload.trackId as number | undefined;
      const zoneName = payload.zoneName as string | undefined;
      const displayName = esc(trackName ?? semanticLabel ?? trackLabel ?? "未知");
      const arrow = event === "track:enter-zone" ? "→" : "←";
      detailHtml = `<tr><td>目标</td><td>${displayName} #${trackId ?? "?"} ${arrow} ${esc(zoneName ?? "?")}</td></tr>`;
    } else if (event === "track:dwell") {
      const trackLabel = payload.label as string | undefined;
      const trackName = payload.trackName as string | undefined;
      const semanticLabel = payload.semanticLabel as string | undefined;
      const trackId = payload.trackId as number | undefined;
      const zoneName = payload.zoneName as string | undefined;
      const dwellMs = payload.dwellMs as number | undefined;
      const displayName = esc(trackName ?? semanticLabel ?? trackLabel ?? "未知");
      detailHtml = `<tr><td>目标</td><td>${displayName} #${trackId ?? "?"} 在 ${esc(zoneName ?? "?")} 停留 ${dwellMs ? `${(dwellMs / 1000).toFixed(0)}s` : "?"}</td></tr>`;
    } else if (event === "track:speed") {
      const trackLabel = payload.label as string | undefined;
      const trackName = payload.trackName as string | undefined;
      const semanticLabel = payload.semanticLabel as string | undefined;
      const trackId = payload.trackId as number | undefined;
      const speed = payload.speed as number | undefined;
      const displayName = esc(trackName ?? semanticLabel ?? trackLabel ?? "未知");
      detailHtml = `<tr><td>目标</td><td>${displayName} #${trackId ?? "?"} 高速移动 (${speed?.toFixed(3) ?? "?"}/帧)</td></tr>`;
    } else if (event === "signal:changed") {
      const signalName = payload.signalName as string | undefined;
      const oldValue = payload.oldValue as string | undefined;
      const newValue = payload.newValue as string | undefined;
      detailHtml = `<tr><td>信号名称</td><td><strong>${esc(signalName ?? "")}</strong></td></tr>`;
      detailHtml += `<tr><td>变更</td><td>${esc(oldValue ?? "")} → ${esc(newValue ?? "")}</td></tr>`;
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
