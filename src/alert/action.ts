import { type EventBus } from "@/event-bus";

/** 告警动作类型 */
export type AlertAction =
  | { type: "notify"; channels: ("webhook" | "dingtalk" | "email")[] }
  | { type: "snapshot"; cameraId?: string }
  | { type: "record"; durationSec: number }
  | { type: "webhook"; url: string; method: "POST" | "PUT"; headers?: Record<string, string> }
  | { type: "setSignal"; signalId: number; value: string };

/** 动作执行上下文 */
export interface ActionContext {
  ruleId: number;
  ruleName: string;
  cameraId: string;
  timestamp: number;
  detail: string;
  eventPayload: Record<string, unknown>;
}

/**
 * 动作执行器
 * 目前主要是发出 alert 事件（通知由外部模块处理）
 * 未来可扩展为：快照、录像、自定义 Webhook、设置信号等
 */
export class ActionExecutor {
  constructor(private eventBus: EventBus) {}

  /** 执行告警动作 */
  async execute(actions: AlertAction[], ctx: ActionContext): Promise<void> {
    /** 标准动作：始终发出 alert 事件 */
    this.eventBus.emit("alert" as never, {
      ruleId: ctx.ruleId,
      ruleName: ctx.ruleName,
      cameraId: ctx.cameraId,
      timestamp: ctx.timestamp,
      detail: ctx.detail,
    } as never);

    /** 扩展动作（未来实现） */
    for (const action of actions) {
      switch (action.type) {
        case "notify":
          /** 通知已由 alert 事件触发（webhook/dingtalk/email 监听 alert 事件） */
          break;
        case "snapshot":
          // TODO: 触发快照
          break;
        case "record":
          // TODO: 触发录像
          break;
        case "webhook":
          await this.executeWebhook(action, ctx);
          break;
        case "setSignal":
          // TODO: 更新信号值
          break;
      }
    }
  }

  /** 执行自定义 Webhook */
  private async executeWebhook(action: { url: string; method: "POST" | "PUT"; headers?: Record<string, string> }, ctx: ActionContext): Promise<void> {
    try {
      await fetch(action.url, {
        method: action.method,
        headers: { "Content-Type": "application/json", ...action.headers },
        body: JSON.stringify(ctx),
      });
    } catch (err) {
      console.warn(`[ActionExecutor] Webhook 调用失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
