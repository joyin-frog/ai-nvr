import { type EventBus } from "@/event-bus";
import { type SignalStore } from "@/signal/store";

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
 * 发出 alert 事件 + 执行扩展动作（webhook、信号更新等）
 */
export class ActionExecutor {
  private signalStore: SignalStore | null = null;

  constructor(private eventBus: EventBus) {}

  /** 注入信号存储（用于 setSignal 动作） */
  setSignalStore(store: SignalStore): void {
    this.signalStore = store;
  }

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

    /** 扩展动作 */
    for (const action of actions) {
      switch (action.type) {
        case "notify":
          /** 通知已由 alert 事件触发（webhook/dingtalk/email 监听 alert 事件） */
          break;
        case "snapshot":
          /** 快照已在 ObserverEngine 匹配时自动保存 */
          break;
        case "record":
          /** 录像由 motion recorder 管理，此处预留触发接口 */
          break;
        case "webhook":
          await this.executeWebhook(action, ctx);
          break;
        case "setSignal":
          this.executeSetSignal(action, ctx);
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

  /** 执行信号更新 */
  private executeSetSignal(action: { signalId: number; value: string }, ctx: ActionContext): void {
    if (!this.signalStore) return;
    const change = this.signalStore.setValue(action.signalId, action.value, `alert:${ctx.ruleId}`, ctx.ruleId);
    if (change) {
      const signalDef = this.signalStore.getSignal(action.signalId);
      this.eventBus.emit("signal:changed", {
        signalId: change.signalId,
        signalName: change.signalName,
        cameraId: change.cameraId,
        oldValue: change.oldValue,
        newValue: change.newValue,
        source: change.source,
        sourceId: change.sourceId,
        timestamp: change.timestamp,
        notify: signalDef?.notifyOnChange ?? false,
      });
    }
  }
}
