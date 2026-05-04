import { type EventBus } from "@/event-bus";
import { type AlertStorage, type AlertRule } from "@/alert/storage";
import { matchEvent } from "@/alert/matcher";
import { WindowAggregator } from "@/alert/window";
import { ActionExecutor } from "@/alert/action";

/**
 * 告警引擎（重构后）
 * 动态订阅 EventBus 事件，通过条件表达式过滤，滑动窗口聚合后触发动作
 */
export class AlertEngine {
  private rules: AlertRule[] = [];
  /** 规则缓存刷新时间 */
  private rulesCacheTime = 0;
  private static readonly CACHE_TTL = 30_000;
  /** 取消订阅函数 */
  private unsubscribers: Array<() => void> = [];
  /** 已订阅的事件类型集合 */
  private subscribedEventTypes = new Set<string>();
  /** 滑动窗口聚合器 */
  private windowAggregator = new WindowAggregator();
  /** 动作执行器 */
  private actionExecutor: ActionExecutor;

  constructor(
    private eventBus: EventBus,
    private storage: AlertStorage,
  ) {
    this.actionExecutor = new ActionExecutor(eventBus);
  }

  /** 启动引擎 */
  start(): void {
    this.refreshRules();
    console.log("[AlertEngine] 告警引擎已启动");
  }

  /** 停止引擎 */
  stop(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
    this.subscribedEventTypes.clear();
    this.windowAggregator.clear();
  }

  /** 刷新规则缓存并动态订阅新事件类型 */
  private refreshRules(): void {
    const now = Date.now();
    if (now - this.rulesCacheTime < AlertEngine.CACHE_TTL && this.rules.length > 0) return;
    this.rulesCacheTime = now;

    this.rules = this.storage.getEnabledRules();

    /** 清理已删除规则的窗口：当前活跃的规则 ID 集合之外的都删除 */
    const activeIds = new Set(this.rules.map(r => r.id));
    for (const rule of this.rules) {
      if (!activeIds.has(rule.id)) this.windowAggregator.removeRule(rule.id);
    }

    /** 动态订阅新出现的事件类型 */
    this.updateDynamicSubscriptions();
  }

  /** 根据规则订阅的事件类型动态注册 EventBus 监听 */
  private updateDynamicSubscriptions(): void {
    const neededTypes = new Set(this.rules.map(r => r.subscription.eventType));

    /** 订阅新类型 */
    for (const eventType of neededTypes) {
      if (!this.subscribedEventTypes.has(eventType)) {
        const unsub = this.eventBus.on(eventType as never, (payload: never) => {
          this.onEvent(eventType, payload as Record<string, unknown>);
        });
        this.unsubscribers.push(unsub);
        this.subscribedEventTypes.add(eventType);
      }
    }
  }

  /** 处理事件 */
  private onEvent(eventType: string, payload: Record<string, unknown>): void {
    this.refreshRules();

    for (const rule of this.rules) {
      if (!matchEvent(rule, eventType, payload)) continue;

      const timestamp = (payload.timestamp as number) ?? Date.now();
      const detail = this.buildDetail(rule, payload);

      if (this.windowAggregator.check(rule, timestamp)) {
        this.storage.insertAlert(
          rule.id, rule.name,
          (payload.cameraId as string) ?? "",
          timestamp,
          detail,
        );

        this.actionExecutor.execute(rule.actions, {
          ruleId: rule.id,
          ruleName: rule.name,
          cameraId: (payload.cameraId as string) ?? "",
          timestamp,
          detail,
          eventPayload: payload,
        });
      }
    }
  }

  /** 构建告警详情 */
  private buildDetail(rule: AlertRule, payload: Record<string, unknown>): string {
    const parts: Record<string, unknown> = {
      eventType: rule.subscription.eventType,
      ruleName: rule.name,
    };
    if (payload.observerId) parts.observerId = payload.observerId;
    if (payload.observerName) parts.observerName = payload.observerName;
    if (payload.signalId) parts.signalId = payload.signalId;
    if (payload.signalName) parts.signalName = payload.signalName;
    if (payload.result) parts.result = payload.result;
    if (payload.confidence !== undefined) parts.confidence = payload.confidence;
    if (payload.oldValue !== undefined) parts.oldValue = payload.oldValue;
    if (payload.newValue !== undefined) parts.newValue = payload.newValue;
    return JSON.stringify(parts);
  }
}
