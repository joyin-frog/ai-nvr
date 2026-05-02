import { type EventBus } from "@/event-bus";
import { type RoiStorage } from "@/storage/roi";
import { type CrossLineStorage } from "@/storage/cross-lines";
import { type RuntimeConfig } from "@/runtime-config";

/** 追踪目标在区域内的状态 */
interface ZoneOccupancy {
  /** 进入时间 */
  enteredAt: number;
  /** 上次触发 dwell 事件的时间 */
  lastDwellAt: number;
}

/** 每个 trackId 在各摄像头上的状态 */
interface TrackZoneState {
  /** trackId → { zoneId → ZoneOccupancy } */
  zones: Map<number, ZoneOccupancy>;
  /** 目标标签 */
  label: string;
  /** 用户名称 */
  trackName?: string;
  /** 上次速度告警时间 */
  lastSpeedAlertAt: number;
  /** 上一帧中心点位置（用于越线检测） */
  prevCx?: number;
  prevCy?: number;
  /** 每条线段的穿越冷却时间（避免连续重复触发） */
  lineCrossCooldown: Map<number, number>;
  /** 上次徘徊告警时间 */
  lastLoiterAlertAt: number;
  /** 徘徊追踪：最近 N 个位置点（用于判断来回移动） */
  loiterPositions: Array<{ ts: number; cx: number; cy: number }>;
}

/** 停留事件触发间隔（毫秒） */
const DWELL_INTERVAL_MS = 5000;

/** 停留事件最低触发阈值（毫秒）— 少于此时间不触发 */
const DWELL_MIN_MS = 3000;

/** 速度告警触发间隔（毫秒）— 同一目标在此期间不重复触发 */
const SPEED_ALERT_INTERVAL_MS = 10000;

/** 越线检测冷却时间（毫秒）— 同一目标对同一线段的触发间隔 */
const LINE_CROSS_COOLDOWN_MS = 5000;

/** 徘徊检测：保留的最近位置点数量 */
const LOITER_POSITION_COUNT = 30;

/** 徘徊告警冷却时间（毫秒） */
const LOITER_ALERT_INTERVAL_MS = 30000;

/**
 * 行为分析器
 * 监听 detect 事件，维护追踪目标的位置与 ROI 区域的关系
 * 产出语义事件：track:enter-zone / track:leave-zone / track:dwell / track:speed / track:line-cross / track:loiter
 */
export class BehaviorAnalyzer {
  private eventBus: EventBus;
  private roiStorage: RoiStorage;
  private crossLineStorage?: CrossLineStorage;
  private runtimeConfig?: RuntimeConfig;
  /** cameraId → trackId → TrackZoneState */
  private states = new Map<string, Map<number, TrackZoneState>>();
  /** cameraId → 解析后的 ROI 多边形（带缓存） */
  private roiCache = new Map<string, Array<{ id: number; name: string; points: Array<{ x: number; y: number }> }>>();
  /** cameraId → 解析后的检测线段（带缓存） */
  private lineCache = new Map<string, Array<{ id: number; name: string; start: { x: number; y: number }; end: { x: number; y: number } }>>();
  /** ROI/线段缓存过期时间 */
  private roiCacheExpiry = 0;
  /** 取消订阅函数 */
  private unsub: (() => void) | null = null;
  /** 定期清理过期状态 */
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(eventBus: EventBus, roiStorage: RoiStorage, crossLineStorage?: CrossLineStorage, runtimeConfig?: RuntimeConfig) {
    this.eventBus = eventBus;
    this.roiStorage = roiStorage;
    this.crossLineStorage = crossLineStorage;
    this.runtimeConfig = runtimeConfig;
  }

  /** 取消订阅函数（camera:offline） */
  private unsubCameraOffline: (() => void) | null = null;

  /** 启动：订阅 detect 事件 */
  start(): void {
    this.unsub = this.eventBus.on("detect", (payload) => {
      this.onDetect(payload.cameraId, payload.timestamp, payload.detections);
    });

    /** 摄像头离线时清理该摄像头的所有状态 */
    this.unsubCameraOffline = this.eventBus.on("camera:offline", ({ cameraId }) => {
      this.states.delete(cameraId);
      this.roiCache.delete(cameraId);
      this.lineCache.delete(cameraId);
    });

    /** 每 60 秒清理超过 5 分钟无更新的过期状态 */
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
  }

  /** 停止 */
  stop(): void {
    if (this.unsub) {
      this.unsub();
      this.unsub = null;
    }
    if (this.unsubCameraOffline) {
      this.unsubCameraOffline();
      this.unsubCameraOffline = null;
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /** 处理检测事件 */
  private onDetect(
    cameraId: string,
    timestamp: number,
    detections: Array<{
      label: string;
      trackId?: number;
      trackName?: string;
      box: { xmin: number; ymin: number; xmax: number; ymax: number };
      velocity?: { dx: number; dy: number };
    }>,
  ): void {
    const zones = this.getZones(cameraId);
    const lines = this.getLines(cameraId);
    const cameraStates = this.getOrCreateCameraStates(cameraId);
    /** 当前帧活跃的 trackId 集合 */
    const activeTrackIds = new Set<number>();

    for (const det of detections) {
      if (det.trackId == null) continue;
      activeTrackIds.add(det.trackId);

      /** 计算检测框中心点 */
      const cx = (det.box.xmin + det.box.xmax) / 2;
      const cy = (det.box.ymin + det.box.ymax) / 2;

      const trackState = this.getOrCreateTrackState(cameraStates, det.trackId, det.label);
      /** 同步最新的 trackName */
      if (det.trackName) trackState.trackName = det.trackName;

      /** 越线检测（在区域检测之前，使用 prevCx/prevCy） */
      if (lines.length > 0 && trackState.prevCx !== undefined && trackState.prevCy !== undefined) {
        for (const line of lines) {
          /** 冷却期检查 */
          const lastCross = trackState.lineCrossCooldown.get(line.id) ?? 0;
          if (timestamp - lastCross < LINE_CROSS_COOLDOWN_MS) continue;

          /** 判断线段穿越：前一帧中心点 → 当前帧中心点的向量是否与检测线段相交 */
          const crossResult = this.segmentCross(
            trackState.prevCx, trackState.prevCy, cx, cy,
            line.start.x, line.start.y, line.end.x, line.end.y,
          );
          if (crossResult) {
            trackState.lineCrossCooldown.set(line.id, timestamp);
            this.eventBus.emit("track:line-cross", {
              cameraId,
              timestamp,
              trackId: det.trackId,
              label: det.label,
              trackName: trackState.trackName,
              lineId: line.id,
              lineName: line.name,
              direction: crossResult,
            });
          }
        }
      }

      /** 更新前一帧中心点 */
      trackState.prevCx = cx;
      trackState.prevCy = cy;

      /** 区域检测（仅在有 ROI 区域时执行） */
      if (zones.length === 0) continue;
      const currentZoneIds = new Set(trackState.zones.keys());

      /** 检查目标在哪些区域 */
      for (const zone of zones) {
        const inside = this.pointInPolygon(cx, cy, zone.points);
        const wasInside = currentZoneIds.has(zone.id);

        if (inside && !wasInside) {
          /** 进入区域 */
          trackState.zones.set(zone.id, { enteredAt: timestamp, lastDwellAt: timestamp });
          this.eventBus.emit("track:enter-zone", {
            cameraId,
            timestamp,
            trackId: det.trackId,
            label: det.label,
            trackName: trackState.trackName,
            zoneId: zone.id,
            zoneName: zone.name,
          });
        } else if (inside && wasInside) {
          /** 在区域内 — 检查是否需要触发 dwell */
          const occ = trackState.zones.get(zone.id)!;
          const dwellMs = timestamp - occ.enteredAt;
          if (dwellMs >= DWELL_MIN_MS && timestamp - occ.lastDwellAt >= DWELL_INTERVAL_MS) {
            occ.lastDwellAt = timestamp;
            this.eventBus.emit("track:dwell", {
              cameraId,
              timestamp,
              trackId: det.trackId,
              label: det.label,
              trackName: trackState.trackName,
              zoneId: zone.id,
              zoneName: zone.name,
              dwellMs,
            });
          }
        } else if (!inside && wasInside) {
          /** 离开区域 */
          const occ = trackState.zones.get(zone.id)!;
          const dwellMs = timestamp - occ.enteredAt;
          trackState.zones.delete(zone.id);
          this.eventBus.emit("track:leave-zone", {
            cameraId,
            timestamp,
            trackId: det.trackId,
            label: det.label,
            trackName: trackState.trackName,
            zoneId: zone.id,
            zoneName: zone.name,
            dwellMs,
          });
        }
      }
    }

    /** 清理本帧不再活跃的 trackId */
    for (const [trackId, trackState] of cameraStates) {
      if (activeTrackIds.has(trackId)) continue;

      /** 目标不再被检测到，视为离开所有区域 */
      if (trackState.zones.size > 0) {
        for (const [zoneId, occ] of trackState.zones) {
          const zone = zones.find(z => z.id === zoneId);
          this.eventBus.emit("track:leave-zone", {
            cameraId,
            timestamp,
            trackId,
            label: trackState.label,
            trackName: trackState.trackName,
            zoneId,
            zoneName: zone?.name ?? "",
            dwellMs: timestamp - occ.enteredAt,
          });
        }
        trackState.zones.clear();
      }
      cameraStates.delete(trackId);
    }

    /** 速度告警：检测高速移动的目标 */
    const speedThreshold = this.runtimeConfig?.get().ai.speedThreshold ?? 0.02;
    for (const det of detections) {
      if (det.trackId == null || !det.velocity) continue;
      const speed = Math.sqrt(det.velocity.dx * det.velocity.dx + det.velocity.dy * det.velocity.dy);
      if (speed < speedThreshold || speedThreshold === 0) continue;
      const trackState = cameraStates.get(det.trackId);
      if (!trackState) continue;
      /** 冷却期检查 */
      if (timestamp - trackState.lastSpeedAlertAt < SPEED_ALERT_INTERVAL_MS) continue;
      trackState.lastSpeedAlertAt = timestamp;
      this.eventBus.emit("track:speed", {
        cameraId,
        timestamp,
        trackId: det.trackId,
        label: det.label,
        trackName: trackState.trackName,
        speed,
        velocity: det.velocity,
      });
    }

    /** 徘徊检测：目标在同一区域反复来回移动 */
    const loiterThreshold = this.runtimeConfig?.get().ai.loiterThreshold ?? 0;
    if (loiterThreshold > 0) {
      for (const det of detections) {
        if (det.trackId == null) continue;
        const trackState = cameraStates.get(det.trackId);
        if (!trackState) continue;
        const cx = (det.box.xmin + det.box.xmax) / 2;
        const cy = (det.box.ymin + det.box.ymax) / 2;

        /** 记录位置 */
        trackState.loiterPositions.push({ ts: timestamp, cx, cy });
        if (trackState.loiterPositions.length > LOITER_POSITION_COUNT) {
          trackState.loiterPositions.shift();
        }

        /** 冷却期检查 */
        if (timestamp - trackState.lastLoiterAlertAt < LOITER_ALERT_INTERVAL_MS) continue;
        /** 至少需要 10 个点才能判断徘徊 */
        if (trackState.loiterPositions.length < 10) continue;

        /** 判断徘徊：最近的位置点跨越的时间段内，目标在区域内来回移动 */
        const loiterSec = loiterThreshold;
        const cutoff = timestamp - loiterSec * 1000;
        const recentPts = trackState.loiterPositions.filter(p => p.ts >= cutoff);
        if (recentPts.length < 8) continue;

        /** 计算位置覆盖面积（归一化包围盒面积）vs 实际移动距离 */
        let minCx = Infinity, maxCx = -Infinity, minCy = Infinity, maxCy = -Infinity;
        for (const p of recentPts) {
          if (p.cx < minCx) minCx = p.cx;
          if (p.cx > maxCx) maxCx = p.cx;
          if (p.cy < minCy) minCy = p.cy;
          if (p.cy > maxCy) maxCy = p.cy;
        }
        const bboxArea = (maxCx - minCx) * (maxCy - minCy);
        /** 计算总移动距离 */
        let totalDist = 0;
        for (let i = 1; i < recentPts.length; i++) {
          const dx = recentPts[i]!.cx - recentPts[i - 1]!.cx;
          const dy = recentPts[i]!.cy - recentPts[i - 1]!.cy;
          totalDist += Math.sqrt(dx * dx + dy * dy);
        }

        /**
         * 徘徊判定：总移动距离远大于包围盒对角线（说明在来回移动）
         * 且包围盒面积不等于 0（不是静止不动）
         */
        const diagLen = Math.sqrt((maxCx - minCx) ** 2 + (maxCy - minCy) ** 2);
        const isMoving = totalDist > diagLen * 2 && bboxArea > 0.001 && bboxArea < 0.3;
        if (!isMoving) continue;

        /** 检查是否在 ROI 区域内 */
        let zoneId = 0;
        let zoneName = "";
        if (zones.length > 0) {
          const inZone = zones.find(z => this.pointInPolygon(cx, cy, z.points));
          if (!inZone) continue;
          zoneId = inZone.id;
          zoneName = inZone.name;
        }

        trackState.lastLoiterAlertAt = timestamp;
        this.eventBus.emit("track:loiter", {
          cameraId,
          timestamp,
          trackId: det.trackId,
          label: det.label,
          trackName: trackState.trackName,
          zoneId,
          zoneName,
          durationMs: timestamp - recentPts[0]!.ts,
          bboxArea,
        });
      }
    }
  }

  /** 获取摄像头的 ROI 多边形（带缓存） */
  private getZones(cameraId: string): Array<{ id: number; name: string; points: Array<{ x: number; y: number }> }> {
    this.refreshGeoCache(cameraId);
    let zones = this.roiCache.get(cameraId);
    if (!zones) {
      zones = this.roiStorage.getEnabledPolygons(cameraId);
      this.roiCache.set(cameraId, zones);
    }
    return zones;
  }

  /** 获取摄像头的检测线段（带缓存） */
  private getLines(cameraId: string): Array<{ id: number; name: string; start: { x: number; y: number }; end: { x: number; y: number } }> {
    if (!this.crossLineStorage) return [];
    this.refreshGeoCache(cameraId);
    let lines = this.lineCache.get(cameraId);
    if (!lines) {
      lines = this.crossLineStorage.getEnabledLines(cameraId);
      this.lineCache.set(cameraId, lines);
    }
    return lines;
  }

  /** 刷新几何缓存（ROI + 线段共享 TTL） */
  private refreshGeoCache(cameraId: string): void {
    const now = Date.now();
    if (now > this.roiCacheExpiry) {
      this.roiCache.clear();
      this.lineCache.clear();
      this.roiCacheExpiry = now + 30_000;
    }
  }

  /** 获取或创建摄像头状态 Map */
  private getOrCreateCameraStates(cameraId: string): Map<number, TrackZoneState> {
    let states = this.states.get(cameraId);
    if (!states) {
      states = new Map();
      this.states.set(cameraId, states);
    }
    return states;
  }

  /** 获取或创建追踪目标状态 */
  private getOrCreateTrackState(cameraStates: Map<number, TrackZoneState>, trackId: number, label: string): TrackZoneState {
    let state = cameraStates.get(trackId);
    if (!state) {
      state = { zones: new Map(), label, lastSpeedAlertAt: 0, lineCrossCooldown: new Map(), lastLoiterAlertAt: 0, loiterPositions: [] };
      cameraStates.set(trackId, state);
    }
    return state;
  }

  /**
   * 判断运动轨迹线段 (p1→p2) 是否穿越检测线段 (p3→p4)
   * 返回穿越方向（A→B 或 B→A），未穿越返回 null
   * 方向判定：运动向量与检测线段法向量的点积符号决定方向
   */
  private segmentCross(
    p1x: number, p1y: number, p2x: number, p2y: number,
    p3x: number, p3y: number, p4x: number, p4y: number,
  ): "A→B" | "B→A" | null {
    /** 运动向量和检测线段向量 */
    const dx = p2x - p1x;
    const dy = p2y - p1y;
    const ex = p4x - p3x;
    const ey = p4y - p3y;

    /** 叉积 d × e */
    const cross = dx * ey - dy * ex;
    if (Math.abs(cross) < 1e-10) return null; // 平行或共线

    /** 参数 t: 运动线段上的交点位置 */
    const t = ((p3x - p1x) * ey - (p3y - p1y) * ex) / cross;
    /** 参数 u: 检测线段上的交点位置 */
    const u = ((p3x - p1x) * dy - (p3y - p1y) * dx) / cross;

    /** 两条线段相交的条件：0 <= t <= 1 且 0 <= u <= 1 */
    if (t < 0 || t > 1 || u < 0 || u > 1) return null;

    /** 方向判定：运动向量与检测线段左侧法向量的点积 */
    /** 法向量 = (-ey, ex)（检测线段左侧） */
    const dotNormal = dx * (-ey) + dy * ex;
    return dotNormal > 0 ? "A→B" : "B→A";
  }

  /** 清理空的摄像头状态 */
  private cleanup(): void {
    for (const [cameraId, cameraStates] of this.states) {
      if (cameraStates.size === 0) {
        this.states.delete(cameraId);
      }
    }
  }

  /**
   * 射线法判断点是否在多边形内
   * 归一化坐标 (0-1)
   */
  private pointInPolygon(px: number, py: number, polygon: Array<{ x: number; y: number }>): boolean {
    let inside = false;
    const n = polygon.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = polygon[i]!.x;
      const yi = polygon[i]!.y;
      const xj = polygon[j]!.x;
      const yj = polygon[j]!.y;
      if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }

  /** 更新追踪名称（由 detector 调用） */
  updateTrackName(cameraId: string, trackId: number, name: string): void {
    const cameraStates = this.states.get(cameraId);
    if (!cameraStates) return;
    const state = cameraStates.get(trackId);
    if (state) state.trackName = name;
  }
}
