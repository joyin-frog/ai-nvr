import { type Detection } from "@/ai/types";

/** 事件载荷类型定义 */
export interface EventPayloads {
  /** 原始帧事件：每到一个帧就触发 */
  frame: {
    /** 摄像头 ID */
    cameraId: string;
    /** JPEG 帧数据 */
    data: Buffer;
    /** 时间戳 */
    timestamp: number;
  };

  /** 变动检测事件：检测到画面有变化时触发 */
  motion: {
    /** 摄像头 ID */
    cameraId: string;
    /** 变动像素占比（0-1） */
    ratio: number;
    /** 触发变动时的帧数据 */
    data: Buffer;
    /** 时间戳 */
    timestamp: number;
  };

  /** AI 检测事件：检测到目标物体时触发 */
  detect: {
    /** 摄像头 ID */
    cameraId: string;
    /** 检测时间戳 */
    timestamp: number;
    /** 检测结果列表 */
    detections: Detection[];
    /** 标注后的图片（JPEG Buffer） */
    annotatedImage: Buffer;
    /** 原始帧图片（JPEG Buffer，无标注） */
    frameImage: Buffer;
    /** 是否为有意义的检测结果变化（用于事件记录/通知去重） */
    changed?: boolean;
    /** AI 推理耗时（毫秒） */
    inferMs?: number;
  };

  /** 摄像头上线 */
  "camera:online": {
    cameraId: string;
  };

  /** 摄像头离线 */
  "camera:offline": {
    cameraId: string;
  };

  /** 摄像头帧率不足（低于阈值） */
  "camera:lowfps": {
    cameraId: string;
    /** 当前帧率 */
    fps: number;
  };

  /** 告警触发：规则匹配时产生 */
  alert: {
    /** 触发的规则 ID */
    ruleId: number;
    /** 规则名称 */
    ruleName: string;
    /** 摄像头 ID */
    cameraId: string;
    /** 时间戳 */
    timestamp: number;
    /** 触发详情 */
    detail: string;
  };

}

/** 事件名类型 */
export type EventName = keyof EventPayloads;

/** 事件回调 */
type EventCallback<T extends EventName> = (payload: EventPayloads[T]) => void;

/**
 * 类型安全的事件总线
 * 用于在模块间解耦通信：帧提取器 → 变动检测器 → API 推送
 */
export class EventBus {
  /** 监听器列表 */
  private listeners = new Map<EventName, Set<EventCallback<EventName>>>();

  /** 订阅事件 */
  on<T extends EventName>(event: T, callback: EventCallback<T>): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    const set = this.listeners.get(event)!;
    set.add(callback as EventCallback<EventName>);

    /** 返回取消订阅函数 */
    return () => set.delete(callback as EventCallback<EventName>);
  }

  /** 触发事件 */
  emit<T extends EventName>(event: T, payload: EventPayloads[T]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const cb of set) {
      try {
        (cb as EventCallback<T>)(payload);
      } catch (err) {
        console.error(`[EventBus] 事件 "${event}" 处理器异常:`, err);
      }
    }
  }

  /** 移除指定事件的所有监听器 */
  off(event: EventName): void {
    this.listeners.delete(event);
  }

  /** 清空所有监听器 */
  clear(): void {
    this.listeners.clear();
  }
}
