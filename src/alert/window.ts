/** 每个规则的滑动窗口状态 */
interface WindowState {
  /** 事件时间戳列表 */
  timestamps: number[];
  /** 上次触发告警的时间 */
  lastAlertTime: number;
}

/** 告警规则窗口检查接口 */
export interface WindowedRule {
  id: number;
  windowSeconds: number;
  threshold: number;
  cooldownSeconds: number;
  silentStart: string;
  silentEnd: string;
}

/**
 * 滑动窗口聚合器
 * 在指定时间窗口内统计事件次数，达到阈值时触发告警
 */
export class WindowAggregator {
  private windows = new Map<number, WindowState>();

  /** 检查规则是否触发，返回 true 表示应触发告警 */
  check(rule: WindowedRule, timestamp: number): boolean {
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
    if (window.timestamps.length < rule.threshold) return false;

    /** 检查静默时段 */
    if (this.isSilentPeriod(rule)) return false;

    /** 检查冷却期 */
    if (timestamp - window.lastAlertTime < rule.cooldownSeconds * 1000) return false;

    /** 触发 */
    window.lastAlertTime = timestamp;
    window.timestamps = [];

    return true;
  }

  /** 清理已删除规则的窗口状态 */
  removeRule(ruleId: number): void {
    this.windows.delete(ruleId);
  }

  /** 判断当前时间是否在静默时段内 */
  private isSilentPeriod(rule: WindowedRule): boolean {
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

  /** 清空所有窗口 */
  clear(): void {
    this.windows.clear();
  }
}
