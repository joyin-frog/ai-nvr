import { type EventBus } from "@/event-bus";
import { type RoiStorage } from "@/storage/roi";

/** 追踪目标在区域内的状态 */
interface ZoneOccupancy {
  /** 进入时间 */
  enteredAt: number;
  /** 上次触发 dwell 事件的时间 */
  lastDwellAt: number;
}

/** 每个 trackId 在各摄像头上的区域占用状态 */
interface TrackZoneState {
  /** trackId → { zoneId → ZoneOccupancy } */
  zones: Map<number, ZoneOccupancy>;
  /** 目标标签 */
  label: string;
  /** 用户名称 */
  trackName?: string;
}

/** 停留事件触发间隔（毫秒） */
const DWELL_INTERVAL_MS = 5000;

/** 停留事件最低触发阈值（毫秒）— 少于此时间不触发 */
const DWELL_MIN_MS = 3000;

/**
 * 行为分析器
 * 监听 detect 事件，维护追踪目标的位置与 ROI 区域的关系
 * 产出语义事件：track:enter-zone / track:leave-zone / track:dwell
 */
export class BehaviorAnalyzer {
  private eventBus: EventBus;
  private roiStorage: RoiStorage;
  /** cameraId → trackId → TrackZoneState */
  private states = new Map<string, Map<number, TrackZoneState>>();
  /** cameraId → 解析后的 ROI 多边形（带缓存） */
  private roiCache = new Map<string, Array<{ id: number; name: string; points: Array<{ x: number; y: number }> }>>();
  /** ROI 缓存过期时间 */
  private roiCacheExpiry = 0;
  /** 取消订阅函数 */
  private unsub: (() => void) | null = null;
  /** 定期清理过期状态 */
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(eventBus: EventBus, roiStorage: RoiStorage) {
    this.eventBus = eventBus;
    this.roiStorage = roiStorage;
  }

  /** 启动：订阅 detect 事件 */
  start(): void {
    this.unsub = this.eventBus.on("detect", (payload) => {
      this.onDetect(payload.cameraId, payload.timestamp, payload.detections);
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
      box: { xmin: number; ymin: number; xmax: number; ymax: number };
    }>,
  ): void {
    const zones = this.getZones(cameraId);
    if (zones.length === 0) return;

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

    /** 清理本帧不再活跃的 trackId — 它们可能已经离开所有区域 */
    for (const [trackId, trackState] of cameraStates) {
      if (activeTrackIds.has(trackId)) continue;
      if (trackState.zones.size === 0) continue;

      /** 目标不再被检测到，视为离开所有区域 */
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
      cameraStates.delete(trackId);
    }
  }

  /** 获取摄像头的 ROI 多边形（带缓存） */
  private getZones(cameraId: string): Array<{ id: number; name: string; points: Array<{ x: number; y: number }> }> {
    const now = Date.now();
    if (now > this.roiCacheExpiry) {
      this.roiCache.clear();
      this.roiCacheExpiry = now + 30_000;
    }
    let zones = this.roiCache.get(cameraId);
    if (!zones) {
      zones = this.roiStorage.getEnabledPolygons(cameraId);
      this.roiCache.set(cameraId, zones);
    }
    return zones;
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
      state = { zones: new Map(), label };
      cameraStates.set(trackId, state);
    }
    return state;
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
