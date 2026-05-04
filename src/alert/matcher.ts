import { type ConditionExpr, evaluate, parseCondition } from "@/alert/condition";

/** 事件订阅配置 */
export interface EventSubscription {
  /** 订阅的事件类型（如 observation, signal:changed, track:enter-zone 等） */
  eventType: string;
  /** 过滤：源对象 ID（0=任意） */
  sourceId: number;
  /** 过滤：摄像头 ID（空=任意） */
  cameraId: string;
}

/** 告警规则匹配接口 */
export interface MatchableRule {
  id: number;
  subscription: EventSubscription;
  condition: string;
  enabled: boolean;
}

/** 条件缓存 */
const conditionCache = new WeakMap<MatchableRule, ConditionExpr | null>();

/**
 * 事件匹配器
 * 判断事件是否匹配某条告警规则的订阅和条件
 */
export function matchEvent(rule: MatchableRule, eventType: string, payload: Record<string, unknown>): boolean {
  if (!rule.enabled) return false;

  /** 事件类型匹配 */
  if (rule.subscription.eventType !== eventType) return false;

  /** 摄像头过滤 */
  if (rule.subscription.cameraId) {
    const eventCameraId = payload.cameraId as string | undefined;
    if (eventCameraId !== rule.subscription.cameraId) return false;
  }

  /** 源 ID 过滤 */
  if (rule.subscription.sourceId > 0) {
    /** 兼容多种事件字段名 */
    const sourceId = payload.observerId ?? payload.signalId ?? payload.ruleId ?? payload.sourceId;
    if (sourceId !== rule.subscription.sourceId) return false;
  }

  /** 条件求值 */
  if (!rule.condition) return true;

  let expr = conditionCache.get(rule);
  if (expr === undefined) {
    expr = parseCondition(rule.condition);
    conditionCache.set(rule, expr);
  }

  if (!expr) return true;
  return evaluate(expr, payload);
}
