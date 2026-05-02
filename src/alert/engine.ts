import { type EventBus } from "@/event-bus";
import { type AlertStorage, type AlertRule } from "@/alert/storage";
import { type TrackLabelStorage } from "@/storage/track-labels";
import { type RoiStorage } from "@/storage/roi";
import { type Annotator } from "@/ai/annotator";

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
  /** 预解析的标签 Set 缓存：ruleId -> Set（避免每事件每规则重复 split） */
  private ruleLabelSets = new Map<number, Set<string>>();
  /** 预解析的命名 Set 缓存：ruleId -> Set */
  private ruleTrackNameSets = new Map<number, Set<string>>();
  /** 每个规则的滑动窗口状态 */
  private windows = new Map<number, RuleWindow>();
  /** 规则缓存刷新时间 */
  private rulesCacheTime = 0;
  /** 缓存 TTL（30 秒） */
  private static readonly CACHE_TTL = 30_000;
  /** EventBus 取消订阅函数 */
  private unsubscribers: Array<() => void> = [];

  /** 追踪标签缓存：cameraId:trackId -> name */
  private trackNameCache = new Map<string, string>();
  /** 每个摄像头的缓存刷新时间 */
  private trackNameCacheTimeByCamera = new Map<string, number>();
  /** ROI 多边形缓存：roiId -> { points, raw } 避免每次 detect 事件重复 JSON.parse */
  private roiPolygonCache = new Map<number, { polygon: Array<{ x: number; y: number }>; raw: string }>();

  /** 告警快照保存回调 */
  private saveAlertSnapshot?: (cameraId: string, timestamp: number, jpeg: Buffer) => void;

  constructor(
    private eventBus: EventBus,
    private storage: AlertStorage,
    private trackLabelStorage?: TrackLabelStorage,
    private roiStorage?: RoiStorage,
    private annotator?: Annotator,
  ) {}

  /** 设置告警快照保存回调 */
  setSaveAlertSnapshot(fn: (cameraId: string, timestamp: number, jpeg: Buffer) => void): void {
    this.saveAlertSnapshot = fn;
  }

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
      this.eventBus.on("track:appeared", (payload) => {
        this.onTrackEvent("track:appeared", payload.cameraId, payload.timestamp, payload.trackId, payload.label, payload.score, undefined, undefined, undefined, undefined, undefined, payload.semanticLabel);
      }),
      this.eventBus.on("track:disappeared", (payload) => {
        this.onTrackEvent("track:disappeared", payload.cameraId, payload.timestamp, payload.trackId, payload.label, undefined, undefined, undefined, undefined, undefined, undefined, payload.semanticLabel);
      }),
      this.eventBus.on("track:enter-zone", (payload) => {
        this.onTrackEvent("track:enter-zone", payload.cameraId, payload.timestamp, payload.trackId, payload.label, undefined, payload.zoneId, payload.zoneName, undefined, undefined, undefined, payload.semanticLabel);
      }),
      this.eventBus.on("track:leave-zone", (payload) => {
        this.onTrackEvent("track:leave-zone", payload.cameraId, payload.timestamp, payload.trackId, payload.label, undefined, payload.zoneId, payload.zoneName, payload.dwellMs, undefined, undefined, payload.semanticLabel);
      }),
      this.eventBus.on("track:dwell", (payload) => {
        this.onTrackEvent("track:dwell", payload.cameraId, payload.timestamp, payload.trackId, payload.label, undefined, payload.zoneId, payload.zoneName, payload.dwellMs, undefined, undefined, payload.semanticLabel);
      }),
      this.eventBus.on("track:speed", (payload) => {
        this.onTrackEvent("track:speed", payload.cameraId, payload.timestamp, payload.trackId, payload.label, undefined, undefined, undefined, undefined, payload.speed, undefined, payload.semanticLabel);
      }),
      this.eventBus.on("track:line-cross", (payload) => {
        this.onTrackEvent("track:line-cross", payload.cameraId, payload.timestamp, payload.trackId, payload.label, undefined, payload.lineId, payload.lineName, undefined, undefined, payload.direction, payload.semanticLabel);
      }),
      this.eventBus.on("track:loiter", (payload) => {
        this.onTrackEvent("track:loiter", payload.cameraId, payload.timestamp, payload.trackId, payload.label, undefined, payload.zoneId, payload.zoneName, payload.durationMs, undefined, undefined, payload.semanticLabel);
      }),
      this.eventBus.on("track:approach", (payload) => {
        this.onTrackEvent("track:approach", payload.cameraId, payload.timestamp, payload.trackId, payload.label, undefined, undefined, undefined, undefined, undefined, undefined, payload.semanticLabel);
      }),
    );
    console.log("[AlertEngine] 告警引擎已启动");
  }

  /** 停止引擎 */
  stop(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
    this.windows.clear();
    this.ruleLabelSets.clear();
    this.ruleTrackNameSets.clear();
    this.trackNameCache.clear();
    this.trackNameCacheTimeByCamera.clear();
    this.roiPolygonCache.clear();
  }

  /** 刷新规则缓存（同时预解析 labels/trackNames 为 Set） */
  private refreshRules(): void {
    const now = Date.now();
    if (now - this.rulesCacheTime < AlertEngine.CACHE_TTL && this.rules.length > 0) return;
    this.rules = this.storage.getEnabledRules();
    this.rulesCacheTime = now;

    /** 预解析标签和命名为 Set */
    this.ruleLabelSets.clear();
    this.ruleTrackNameSets.clear();
    for (const rule of this.rules) {
      if (rule.labels) {
        this.ruleLabelSets.set(rule.id, new Set(rule.labels.split(",").map(l => l.trim().toLowerCase()).filter(Boolean)));
      }
      if (rule.trackNames) {
        this.ruleTrackNameSets.set(rule.id, new Set(rule.trackNames.split(",").map(n => n.trim())));
      }
    }

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

  /** 处理追踪目标事件（track:appeared / track:disappeared / track:enter-zone / track:leave-zone / track:dwell / track:speed / track:line-cross） */
  private onTrackEvent(eventType: string, cameraId: string, timestamp: number, trackId: number, label: string, score?: number, zoneId?: number, zoneName?: string, dwellMs?: number, speed?: number, direction?: string, semanticLabel?: string): void {
    this.refreshRules();
    this.refreshTrackNames(cameraId);

    const trackName = this.trackNameCache.get(`${cameraId}:${trackId}`);

    for (const rule of this.rules) {
      if (rule.eventType !== eventType) continue;
      if (rule.cameraId && rule.cameraId !== cameraId) continue;

      /** 标签过滤（同时匹配原始 label 和 semanticLabel，使用预解析 Set） */
      const labelSet = this.ruleLabelSets.get(rule.id);
      if (labelSet) {
        const matchLabel = labelSet.has(label.toLowerCase());
        const matchSemantic = semanticLabel && labelSet.has(semanticLabel.toLowerCase());
        if (!matchLabel && !matchSemantic) continue;
      }

      /** 命名匹配（使用预解析 Set） */
      const nameSet = this.ruleTrackNameSets.get(rule.id);
      if (nameSet) {
        if (!trackName || !nameSet.has(trackName)) continue;
      }

      /** ROI 区域过滤 */
      if (rule.roiId && zoneId !== undefined && rule.roiId !== zoneId) continue;

      /** 最小速度过滤（仅 track:speed 事件） */
      if (rule.minSpeed > 0 && speed !== undefined && speed < rule.minSpeed) continue;

      const detailObj: Record<string, unknown> = { trackId, label, trackName };
      if (semanticLabel) detailObj.semanticLabel = semanticLabel;
      if (zoneId !== undefined) detailObj.zoneId = zoneId;
      if (zoneName) detailObj.zoneName = zoneName;
      if (dwellMs !== undefined) detailObj.dwellMs = dwellMs;
      if (score !== undefined) detailObj.score = score;
      if (speed !== undefined) detailObj.speed = speed;
      if (direction) detailObj.direction = direction;

      void score;
      this.checkRule(rule, cameraId, timestamp, JSON.stringify(detailObj));
    }
  }

  /** 处理 detect 事件（需要标签过滤 + 数量条件 + 命名匹配 + ROI 过滤） */
  private onDetect(cameraId: string, timestamp: number, detections: Array<{ label: string; score: number; trackId?: number; box?: { xmin: number; ymin: number; xmax: number; ymax: number }; semanticLabel?: string }>): void {
    this.refreshRules();
    this.refreshTrackNames(cameraId);

    for (const rule of this.rules) {
      if (rule.eventType !== "detect") continue;
      if (rule.cameraId && rule.cameraId !== cameraId) continue;

      /** 标签过滤（使用预解析 keywords，支持子字符串匹配）+ 数量统计 */
      let matchedDetections = detections;
      const labelSet = this.ruleLabelSets.get(rule.id);
      if (labelSet) {
        const keywords = [...labelSet];
        matchedDetections = detections.filter(d => {
          const labelLower = d.label.toLowerCase();
          const semanticLower = d.semanticLabel?.toLowerCase() ?? "";
          return keywords.some(kw => labelLower.includes(kw) || semanticLower.includes(kw));
        });
        if (matchedDetections.length === 0) continue;
      }

      /** 命名匹配（使用预解析 Set） */
      const nameSet = this.ruleTrackNameSets.get(rule.id);
      if (nameSet) {
        matchedDetections = matchedDetections.filter(d => {
          if (!d.trackId) return false;
          const name = this.trackNameCache.get(`${cameraId}:${d.trackId}`);
          return name && nameSet.has(name);
        });
        if (matchedDetections.length === 0) continue;
      }

      /** ROI 区域过滤：只保留检测框中心在 ROI 多边形内的目标 */
      if (rule.roiId > 0 && this.roiStorage) {
        const roi = this.roiStorage.getById(rule.roiId);
        if (roi && roi.points) {
          let cached = this.roiPolygonCache.get(rule.roiId);
          if (!cached || cached.raw !== roi.points) {
            cached = { polygon: JSON.parse(roi.points) as Array<{ x: number; y: number }>, raw: roi.points };
            this.roiPolygonCache.set(rule.roiId, cached);
          }
          const polygon = cached.polygon;
          matchedDetections = matchedDetections.filter(d => {
            if (!d.box) return false;
            const cx = (d.box.xmin + d.box.xmax) / 2;
            const cy = (d.box.ymin + d.box.ymax) / 2;
            return this.pointInPolygon(cx, cy, polygon);
          });
          if (matchedDetections.length === 0) continue;
        }
      }

      /** 数量条件：匹配标签的目标数必须 >= minCount */
      if (rule.minCount > 0 && matchedDetections.length < rule.minCount) continue;

      const labels = matchedDetections.map(d => {
        const name = d.trackId ? this.trackNameCache.get(`${cameraId}:${d.trackId}`) : undefined;
        const nameTag = name ? ` (${name})` : "";
        return `${d.label}#${d.trackId ?? "?"}${nameTag}(${(d.score * 100).toFixed(0)}%)`;
      }).join(", ");
      /** 包含 bbox 数据用于前端标注叠加 */
      const detailObj: Record<string, unknown> = { detections: labels };
      if (rule.minCount > 0) detailObj.count = matchedDetections.length;
      if (matchedDetections.some(d => d.box)) {
        detailObj.boxes = matchedDetections
          .filter(d => d.box)
          .map(d => ({
            label: d.label,
            score: d.score,
            trackId: d.trackId,
            semanticLabel: d.semanticLabel,
            box: d.box,
          }));
      }
      this.checkRule(rule, cameraId, timestamp, JSON.stringify(detailObj));
    }
  }

  /** 判断点 (x, y) 是否在多边形内（射线法） */
  private pointInPolygon(x: number, y: number, polygon: Array<{ x: number; y: number }>): boolean {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i]!.x, yi = polygon[i]!.y;
      const xj = polygon[j]!.x, yj = polygon[j]!.y;
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }

  /** 刷新追踪标签缓存（按摄像头独立 30 秒 TTL） */
  private refreshTrackNames(cameraId: string): void {
    if (!this.trackLabelStorage) return;
    const now = Date.now();
    const lastTime = this.trackNameCacheTimeByCamera.get(cameraId) ?? 0;
    if (now - lastTime < AlertEngine.CACHE_TTL) return;
    /** 只清除当前摄像头的缓存 */
    const prefix = `${cameraId}:`;
    for (const key of this.trackNameCache.keys()) {
      if (key.startsWith(prefix)) this.trackNameCache.delete(key);
    }
    for (const label of this.trackLabelStorage.listByCamera(cameraId)) {
      if (label.name) {
        this.trackNameCache.set(`${cameraId}:${label.trackId}`, label.name);
      }
    }
    this.trackNameCacheTimeByCamera.set(cameraId, now);
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

    /** 异步保存带检测框的告警快照 */
    if (this.annotator && this.saveAlertSnapshot) {
      this.annotator.generateAnnotated(cameraId).then((jpeg) => {
        if (jpeg) this.saveAlertSnapshot!(cameraId, timestamp, jpeg);
      }).catch(() => { /* 快照保存失败不影响告警流程 */ });
    }

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
