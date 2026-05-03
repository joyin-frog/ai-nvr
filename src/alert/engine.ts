import { type EventBus } from "@/event-bus";
import { type AlertStorage, type AlertRule } from "@/alert/storage";

/** 每个规则的滑动窗口事件时间戳 */
interface RuleWindow {
  /** 事件时间戳列表 */
  timestamps: number[];
  /** 上次触发告警的时间 */
  lastAlertTime: number;
}

/** 匹配条件解析结果 */
interface ParsedCondition {
  resultContains?: string;
  valueEquals?: string;
  valueNotEquals?: string;
}

/**
 * 告警规则引擎
 * 监听 detect:rule（检测规则匹配）和 state:changed（状态变更）事件，
 * 按规则进行滑动窗口计数，匹配时记录告警并触发 alert 事件
 */
export class AlertEngine {
  /** 规则缓存 */
  private rules: AlertRule[] = [];
  /** 条件解析缓存：ruleId → ParsedCondition */
  private conditionCache = new Map<number, ParsedCondition>();
  /** 每个规则的滑动窗口状态 */
  private windows = new Map<number, RuleWindow>();
  /** 规则缓存刷新时间 */
  private rulesCacheTime = 0;
  private static readonly CACHE_TTL = 30_000;
  /** EventBus 取消订阅函数 */
  private unsubscribers: Array<() => void> = [];

  constructor(
    private eventBus: EventBus,
    private storage: AlertStorage,
  ) {}

  /** 启动引擎 */
  start(): void {
    this.refreshRules();
    this.unsubscribers.push(
      this.eventBus.on("detect:rule", (payload) => {
        this.onDetectRule(payload.ruleId, payload.ruleName, payload.cameraId, payload.timestamp, payload.result, payload.confidence);
      }),
      this.eventBus.on("state:changed", (payload) => {
        this.onStateChanged(payload.stateId, payload.stateName, payload.cameraId, payload.oldValue, payload.newValue, payload.timestamp);
      }),
    );
    console.log("[AlertEngine] 告警引擎已启动");
  }

  /** 停止引擎 */
  stop(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
    this.windows.clear();
    this.conditionCache.clear();
  }

  /** 刷新规则缓存 + 预解析 condition */
  private refreshRules(): void {
    const now = Date.now();
    if (now - this.rulesCacheTime < AlertEngine.CACHE_TTL && this.rules.length > 0) return;
    this.rules = this.storage.getEnabledRules();
    this.rulesCacheTime = now;

    /** 预解析条件 JSON */
    this.conditionCache.clear();
    for (const rule of this.rules) {
      if (rule.condition) {
        try {
          this.conditionCache.set(rule.id, JSON.parse(rule.condition) as ParsedCondition);
        } catch { /* 无效 JSON 忽略 */ }
      }
    }

    /** 清理已删除规则的滑动窗口 */
    const activeIds = new Set(this.rules.map(r => r.id));
    for (const id of this.windows.keys()) {
      if (!activeIds.has(id)) this.windows.delete(id);
    }
  }

  /** 处理 detect:rule 事件 */
  private onDetectRule(ruleId: number, ruleName: string, cameraId: string, timestamp: number, result: string, confidence: number): void {
    this.refreshRules();

    for (const rule of this.rules) {
      if (rule.eventType !== "detect:rule") continue;
      if (rule.cameraId && rule.cameraId !== cameraId) continue;
      /** 指定了源规则 ID 则必须匹配 */
      if (rule.sourceRuleId > 0 && rule.sourceRuleId !== ruleId) continue;

      /** 检查 resultContains 条件 */
      const cond = this.conditionCache.get(rule.id);
      if (cond?.resultContains && !result.includes(cond.resultContains)) continue;

      const detail = JSON.stringify({ sourceRuleId: ruleId, sourceRuleName: ruleName, result, confidence });
      this.checkRule(rule, cameraId, timestamp, detail);
    }
  }

  /** 处理 state:changed 事件 */
  private onStateChanged(stateId: number, stateName: string, cameraId: string, oldValue: string, newValue: string, timestamp: number): void {
    this.refreshRules();

    for (const rule of this.rules) {
      if (rule.eventType !== "state:changed") continue;
      if (rule.cameraId && rule.cameraId !== cameraId) continue;
      /** 指定了源状态 ID 则必须匹配 */
      if (rule.sourceStateId > 0 && rule.sourceStateId !== stateId) continue;

      /** 检查 valueEquals / valueNotEquals 条件 */
      const cond = this.conditionCache.get(rule.id);
      if (cond?.valueEquals !== undefined && newValue !== cond.valueEquals) continue;
      if (cond?.valueNotEquals !== undefined && newValue === cond.valueNotEquals) continue;

      const detail = JSON.stringify({ sourceStateId: stateId, sourceStateName: stateName, oldValue, newValue });
      this.checkRule(rule, cameraId, timestamp, detail);
    }
  }

  /** 判断当前时间是否在静默时段内 */
  private isSilentPeriod(rule: AlertRule): boolean {
    if (!rule.silentStart || !rule.silentEnd) return false;
    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const startParts = rule.silentStart.split(":").map(Number);
    const endParts = rule.silentEnd.split(":").map(Number);
    const startMinutes = (startParts[0] ?? 0) * 60 + (startParts[1] ?? 0);
    const endMinutes = (endParts[0] ?? 0) * 60 + (endParts[1] ?? 0);

    if (startMinutes > endMinutes) {
      return currentMinutes >= startMinutes || currentMinutes < endMinutes;
    }
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }

  /** 检查规则是否触发告警 */
  private checkRule(rule: AlertRule, cameraId: string, timestamp: number, detail?: string): void {
    let window = this.windows.get(rule.id);
    if (!window) {
      window = { timestamps: [], lastAlertTime: 0 };
      this.windows.set(rule.id, window);
    }

    window.timestamps.push(timestamp);

    /** 清理窗口外的事件 */
    const windowStart = timestamp - rule.windowSeconds * 1000;
    window.timestamps = window.timestamps.filter(t => t >= windowStart);

    /** 检查是否达到阈值 */
    if (window.timestamps.length < rule.threshold) return;

    /** 检查静默时段 */
    if (this.isSilentPeriod(rule)) return;

    /** 检查冷却期 */
    if (timestamp - window.lastAlertTime < rule.cooldownSeconds * 1000) return;

    /** 触发告警 */
    window.lastAlertTime = timestamp;

    /** 写入存储 */
    this.storage.insertAlert(rule.id, rule.name, cameraId, timestamp, detail ?? "");

    /** 触发 alert 事件到 EventBus */
    this.eventBus.emit("alert" as never, {
      ruleId: rule.id,
      ruleName: rule.name,
      cameraId,
      timestamp,
      detail: detail ?? "",
    } as never);

    /** 重置窗口 */
    window.timestamps = [];
  }
}
