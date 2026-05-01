import { type EventBus } from "@/event-bus";
import { type AlertStorage, type AlertRule } from "@/alert/storage";

/** 每个规则的滑动窗口事件时间戳 */
interface RuleWindow {
  /** 事件时间戳列表 */
  timestamps: number[];
  /** 上次触发告警的时间 */
  lastAlertTime: number;
}

/**
 * 告警规则引擎
 * 监听 EventBus 事件，按规则进行滑动窗口计数，
 * 匹配时记录告警并触发 alert 事件
 */
export class AlertEngine {
  /** 规则缓存（每 30 秒刷新一次） */
  private rules: AlertRule[] = [];
  /** 每个规则的滑动窗口状态 */
  private windows = new Map<number, RuleWindow>();
  /** 规则缓存刷新时间 */
  private rulesCacheTime = 0;
  /** 缓存 TTL（30 秒） */
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
      this.eventBus.on("motion", (payload) => this.onEvent("motion", payload.cameraId, payload.timestamp, payload.ratio)),
      this.eventBus.on("detect", (payload) => this.onDetect(payload.cameraId, payload.timestamp, payload.detections)),
      this.eventBus.on("camera:offline", (payload) => {
        this.onEvent("camera:offline", payload.cameraId, Date.now());
      }),
      this.eventBus.on("camera:lowfps", (payload) => {
        this.onEvent("camera:lowfps", payload.cameraId, Date.now(), `FPS: ${payload.fps}`);
      }),
    );
    console.log("[AlertEngine] 告警引擎已启动");
  }

  /** 停止引擎 */
  stop(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
    this.windows.clear();
  }

  /** 刷新规则缓存 */
  private refreshRules(): void {
    const now = Date.now();
    if (now - this.rulesCacheTime < AlertEngine.CACHE_TTL && this.rules.length > 0) return;
    this.rules = this.storage.getEnabledRules();
    this.rulesCacheTime = now;
    /** 清理已删除规则的滑动窗口 */
    const activeIds = new Set(this.rules.map(r => r.id));
    for (const id of this.windows.keys()) {
      if (!activeIds.has(id)) this.windows.delete(id);
    }
  }

  /** 处理通用事件（motion / camera:offline / camera:lowfps） */
  private onEvent(eventType: string, cameraId: string, timestamp: number, extra?: string | number): void {
    this.refreshRules();

    for (const rule of this.rules) {
      if (rule.eventType !== eventType) continue;
      if (rule.cameraId && rule.cameraId !== cameraId) continue;
      const detail = typeof extra === 'string' ? extra : extra !== undefined ? JSON.stringify({ ratio: extra }) : undefined;
      this.checkRule(rule, cameraId, timestamp, detail);
    }
  }

  /** 处理 detect 事件（需要标签过滤 + 数量条件） */
  private onDetect(cameraId: string, timestamp: number, detections: Array<{ label: string; score: number }>): void {
    this.refreshRules();

    for (const rule of this.rules) {
      if (rule.eventType !== "detect") continue;
      if (rule.cameraId && rule.cameraId !== cameraId) continue;

      /** 标签过滤 + 数量统计 */
      let matchedDetections = detections;
      if (rule.labels) {
        const requiredLabels = new Set(rule.labels.split(",").map(l => l.trim().toLowerCase()));
        matchedDetections = detections.filter(d => requiredLabels.has(d.label.toLowerCase()));
        if (matchedDetections.length === 0) continue;
      }

      /** 数量条件：匹配标签的目标数必须 >= minCount */
      if (rule.minCount > 0 && matchedDetections.length < rule.minCount) continue;

      const labels = matchedDetections.map(d => `${d.label}(${(d.score * 100).toFixed(0)}%)`).join(", ");
      const detail = rule.minCount > 0
        ? JSON.stringify({ detections: labels, count: matchedDetections.length })
        : JSON.stringify({ detections: labels });
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

    /** 跨午夜的情况：如 22:00 - 06:00 */
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

    /** 添加当前事件到窗口 */
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

    /** 重置窗口（告警后清空，避免重复计数） */
    window.timestamps = [];
  }
}
