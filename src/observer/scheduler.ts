import { type Observer } from "@/observer/types";
import { type ObserverStorage } from "@/observer/storage";

/** 全局最大并发 VLM 调用数 */
const MAX_CONCURRENT = 3;

/** 时段配置（预计算分钟数，避免每次 split） */
interface ScheduleConfig {
  enabled: boolean;
  /** 0=周日, 1=周一, ..., 6=周六 */
  days: number[];
  /** 开始时间（一天中的分钟数） */
  startMinutes: number;
  /** 结束时间（一天中的分钟数） */
  endMinutes: number;
}

/** 观测器定时调度器 */
export class Scheduler {
  /** 每条规则的定时器 */
  private timers = new Map<number, ReturnType<typeof setInterval>>();
  /** 每条规则定时器的间隔 */
  private timerIntervals = new Map<number, number>();
  /** 每条规则上次触发时间（冷却） */
  private lastTriggerTime = new Map<number, number>();
  /** 当前并发数 */
  private concurrent = 0;
  /** 排队等待的任务 */
  private queue: Array<{ observer: Observer; timestamp: number }> = [];
  /** 队列上限，防止 API 故障时堆积过多过期帧 */
  private static readonly MAX_QUEUE = 50;
  /** 规则缓存 */
  private observersCache: Observer[] = [];
  private cacheTime = 0;
  private static readonly CACHE_TTL = 30_000;
  /** schedule 解析缓存 */
  private scheduleCache = new Map<string, ScheduleConfig | null>();
  /** 是否已启动 */
  private started = false;

  constructor(
    private storage: ObserverStorage,
    /** 实际执行检测的回调 */
    private onExecute: (observer: Observer, frame: Buffer, timestamp: number) => Promise<void>,
    /** 获取帧的回调 */
    private getFrame: (cameraId: string) => Buffer | undefined,
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.refreshAndStartTimers();
  }

  stop(): void {
    this.started = false;
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
    this.timerIntervals.clear();
    this.lastTriggerTime.clear();
    this.queue = [];
    this.concurrent = 0;
    this.scheduleCache.clear();
  }

  reloadRules(): void {
    this.cacheTime = 0;
    this.scheduleCache.clear();
    if (this.started) this.refreshAndStartTimers();
  }

  /** 并发槽位释放后调用 */
  onSlotFreed(): void {
    this.concurrent--;
    this.processQueue();
  }

  /** 并发槽位占用 */
  takeSlot(): void {
    this.concurrent++;
  }

  /** 刷新规则缓存并重建定时器 */
  private refreshAndStartTimers(): void {
    const now = Date.now();
    if (now - this.cacheTime < Scheduler.CACHE_TTL && this.observersCache.length > 0) return;
    this.cacheTime = now;

    const observers = this.storage.getEnabledObservers();
    const activeIds = new Set(observers.map(o => o.id));
    const byId = new Map(observers.map(o => [o.id, o]));

    /** 停止已删除/禁用的规则定时器，以及 intervalMs 变更的定时器 */
    for (const [id, timer] of this.timers) {
      if (!activeIds.has(id)) {
        clearInterval(timer);
        this.timers.delete(id);
        this.timerIntervals.delete(id);
        this.lastTriggerTime.delete(id);
      } else {
        const current = byId.get(id)!;
        const interval = Math.max(current.intervalMs, 1000);
        if (this.timerIntervals.get(id) !== interval) {
          clearInterval(timer);
          this.timers.delete(id);
          this.timerIntervals.delete(id);
        }
      }
    }

    /** 启动新规则 */
    for (const obs of observers) {
      if (!this.timers.has(obs.id)) {
        this.startObserverTimer(obs);
      }
    }

    this.observersCache = observers;
  }

  private startObserverTimer(obs: Observer): void {
    const interval = Math.max(obs.intervalMs, 1000);
    const obsId = obs.id;
    const timer = setInterval(() => {
      this.refreshAndStartTimers();
      const latest = this.observersCache.find(o => o.id === obsId);
      if (latest) this.scheduleExecution(latest);
    }, interval);
    this.timers.set(obsId, timer);
    this.timerIntervals.set(obsId, interval);
  }

  /** 调度执行（带并发控制 + 时段检查） */
  private scheduleExecution(obs: Observer): void {
    /** 冷却检查 */
    const lastTime = this.lastTriggerTime.get(obs.id) ?? 0;
    if (Date.now() - lastTime < obs.cooldownMs) return;

    /** 时段检查 */
    if (!this.isInSchedule(obs)) return;

    /** 帧存在检查 */
    const frame = this.getFrame(obs.cameras[0]?.cameraId ?? "");
    if (!frame) return;

    if (this.concurrent >= MAX_CONCURRENT) {
      if (this.queue.length < Scheduler.MAX_QUEUE) {
        this.queue.push({ observer: obs, timestamp: Date.now() });
      }
      return;
    }

    /** 原子递增并发计数（在 onExecute 之前，保证 check-increment 不可分割） */
    this.concurrent++;
    this.onExecute(obs, frame, Date.now()).catch((err) => {
      console.warn(`[Scheduler] onExecute failed for observer ${obs.id}:`, err instanceof Error ? err.message : String(err));
    });
  }

  private processQueue(): void {
    while (this.queue.length > 0 && this.concurrent < MAX_CONCURRENT) {
      const item = this.queue.shift()!;
      if (!this.isInSchedule(item.observer)) continue;
      const frame = this.getFrame(item.observer.cameras[0]?.cameraId ?? "");
      if (frame) {
        this.concurrent++;
        this.onExecute(item.observer, frame, item.timestamp).catch((err) => {
          console.warn(`[Scheduler] onExecute failed for observer ${item.observer.id}:`, err instanceof Error ? err.message : String(err));
        });
      }
    }
  }

  /** 检查当前时间是否在观测器配置的启用时段内 */
  isInSchedule(obs: Observer): boolean {
    if (!obs.schedule) return true;
    let config = this.scheduleCache.get(obs.schedule);
    if (config === undefined) {
      try {
        const raw = JSON.parse(obs.schedule) as { enabled?: boolean; start?: string; end?: string; days?: number[] };
        const [sH, sM] = (raw.start ?? "00:00").split(":").map(Number);
        const [eH, eM] = (raw.end ?? "23:59").split(":").map(Number);
        config = {
          enabled: raw.enabled !== false,
          days: raw.days ?? [],
          startMinutes: (sH ?? 0) * 60 + (sM ?? 0),
          endMinutes: (eH ?? 23) * 60 + (eM ?? 59),
        };
      } catch (e) {
        console.warn("[Scheduler] 观测器配置解析失败:", e);
        config = null;
      }
      this.scheduleCache.set(obs.schedule, config);
    }
    if (!config) return true;
    if (!config.enabled) return false;

    const now = new Date();
    if (config.days.length > 0 && !config.days.includes(now.getDay())) return false;

    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    if (config.startMinutes <= config.endMinutes) {
      return currentMinutes >= config.startMinutes && currentMinutes <= config.endMinutes;
    }
    return currentMinutes >= config.startMinutes || currentMinutes <= config.endMinutes;
  }

  /** 更新冷却时间 */
  updateCooldown(observerId: number, timestamp: number): void {
    this.lastTriggerTime.set(observerId, timestamp);
  }
}
