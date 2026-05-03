import { type Detection } from "@/ai/types";
import { type Fmp4InitSegment } from "@/camera/h264-fmp4-muxer";
import { type LlmSceneResult } from "@/ai/multimodal-analyzer";

/** 事件载荷类型定义 */
export interface EventPayloads {
  /** 原始帧事件：每到一个帧就触发，用于前端显示和录像 */
  frame: {
    /** 摄像头 ID */
    cameraId: string;
    /** JPEG 帧数据 */
    data: Buffer;
    /** 时间戳 */
    timestamp: number;
  };

  /** 检测帧事件：用于 AI 检测和变动检测（双流模式下由 SD 流触发，单流模式等同于 frame） */
  "detect:frame": {
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
    /** 原始帧图片（JPEG Buffer，无标注） */
    frameImage: Buffer;
    /** 是否为有意义的检测结果变化（用于事件记录/通知去重） */
    changed?: boolean;
    /** AI 推理耗时（毫秒） */
    inferMs?: number;
  };

  /** 摄像头上线（由 CameraManager 去重后统一发射） */
  "camera:online": {
    cameraId: string;
  };

  /** 摄像头离线（由 CameraManager 去重后统一发射） */
  "camera:offline": {
    cameraId: string;
  };

  /** 内部事件：单个 extractor 上线（不对外，CameraManager 用于去重） */
  "extractor:online": {
    cameraId: string;
    /** 上线的 extractor 类型 */
    source: "frame" | "fmp4";
  };

  /** 内部事件：单个 extractor 离线（不对外，CameraManager 用于去重） */
  "extractor:offline": {
    cameraId: string;
    /** 离线的 extractor 类型 */
    source: "frame" | "fmp4";
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

  /** 检测规则匹配事件 */
  "detect:rule": {
    /** 规则 ID */
    ruleId: number;
    /** 规则名称 */
    ruleName: string;
    /** 摄像头 ID */
    cameraId: string;
    /** 时间戳 */
    timestamp: number;
    /** 用户提示词 */
    prompt: string;
    /** AI 分析结果描述 */
    result: string;
    /** 置信度 0-1 */
    confidence: number;
    /** 详细信息 JSON */
    detail: string;
    /** 目标区域坐标（可选） */
    regions?: Array<{ label: string; box: { xmin: number; ymin: number; xmax: number; ymax: number } }>;
  };

  /** 追踪目标出现 */
  "track:appeared": {
    /** 摄像头 ID */
    cameraId: string;
    /** 时间戳 */
    timestamp: number;
    /** 追踪 ID */
    trackId: number;
    /** 目标标签 */
    label: string;
    /** 置信度 */
    score: number;
    /** 用户自定义名称 */
    trackName?: string;
    /** CLIP 语义标签 */
    semanticLabel?: string;
  };

  /** 追踪目标消失 */
  "track:disappeared": {
    /** 摄像头 ID */
    cameraId: string;
    /** 时间戳 */
    timestamp: number;
    /** 追踪 ID */
    trackId: number;
    /** 目标标签 */
    label: string;
    /** 用户自定义名称 */
    trackName?: string;
    /** CLIP 语义标签 */
    semanticLabel?: string;
  };

  /** 追踪目标标签更新（广播给其他客户端） */
  "track:label-updated": {
    cameraId: string;
    trackId: number;
    name: string;
  };

  /** 追踪目标进入 ROI 区域 */
  "track:enter-zone": {
    cameraId: string;
    timestamp: number;
    trackId: number;
    label: string;
    trackName?: string;
    /** CLIP 语义标签 */
    semanticLabel?: string;
    /** ROI 区域 ID */
    zoneId: number;
    /** ROI 区域名称 */
    zoneName: string;
  };

  /** 追踪目标离开 ROI 区域 */
  "track:leave-zone": {
    cameraId: string;
    timestamp: number;
    trackId: number;
    label: string;
    trackName?: string;
    /** CLIP 语义标签 */
    semanticLabel?: string;
    /** ROI 区域 ID */
    zoneId: number;
    /** ROI 区域名称 */
    zoneName: string;
    /** 在区域内停留的毫秒数 */
    dwellMs: number;
  };

  /** 追踪目标在 ROI 区域内停留（定期触发） */
  "track:dwell": {
    cameraId: string;
    timestamp: number;
    trackId: number;
    label: string;
    trackName?: string;
    /** CLIP 语义标签 */
    semanticLabel?: string;
    /** ROI 区域 ID */
    zoneId: number;
    /** ROI 区域名称 */
    zoneName: string;
    /** 已停留的毫秒数 */
    dwellMs: number;
  };

  /** 目标高速移动事件 */
  "track:speed": {
    cameraId: string;
    timestamp: number;
    trackId: number;
    label: string;
    trackName?: string;
    /** CLIP 语义标签 */
    semanticLabel?: string;
    /** 移动速度（归一化坐标/帧的向量长度） */
    speed: number;
    /** 速度向量 */
    velocity: { dx: number; dy: number };
  };

  /** 追踪目标穿越检测线段 */
  "track:line-cross": {
    /** 摄像头 ID */
    cameraId: string;
    /** 时间戳 */
    timestamp: number;
    /** 追踪 ID */
    trackId: number;
    /** 目标标签 */
    label: string;
    /** 用户自定义名称 */
    trackName?: string;
    /** CLIP 语义标签 */
    semanticLabel?: string;
    /** 检测线段 ID */
    lineId: number;
    /** 检测线段名称 */
    lineName: string;
    /** 穿越方向：A→B 或 B→A（线段方向由起点到终点定义） */
    direction: "A→B" | "B→A";
  };

  /** 追踪目标外观匹配建议（与已命名目标相似时触发） */
  "track:match-suggest": {
    /** 摄像头 ID */
    cameraId: string;
    /** 时间戳 */
    timestamp: number;
    /** 新目标 trackId */
    trackId: number;
    /** 目标标签 */
    label: string;
    /** 匹配建议列表 */
    matches: Array<{
      trackId: number;
      customName: string;
      /** 汉明距离（越小越相似） */
      distance: number;
    }>;
  };

  /** 追踪目标徘徊检测（目标在区域内来回移动超过阈值） */
  "track:loiter": {
    cameraId: string;
    timestamp: number;
    trackId: number;
    label: string;
    trackName?: string;
    /** CLIP 语义标签 */
    semanticLabel?: string;
    /** 所在区域 ID（0 = 不在任何 ROI 区域内） */
    zoneId: number;
    zoneName: string;
    /** 徘徊持续时间（ms） */
    durationMs: number;
    /** 位置包围盒面积（归一化） */
    bboxArea: number;
  };

  /** 追踪目标接近事件（两个目标距离低于阈值时触发） */
  "track:approach": {
    /** 摄像头 ID */
    cameraId: string;
    /** 时间戳 */
    timestamp: number;
    /** 主动目标 trackId */
    trackId: number;
    /** 主动目标标签 */
    label: string;
    /** 主动目标名称 */
    trackName?: string;
    /** 主动目标 CLIP 语义标签 */
    semanticLabel?: string;
    /** 被动目标 trackId */
    targetTrackId: number;
    /** 被动目标标签 */
    targetLabel: string;
    /** 被动目标名称 */
    targetTrackName?: string;
    /** 被动目标 CLIP 语义标签 */
    targetSemanticLabel?: string;
    /** 两目标中心距离（归一化 0-1） */
    distance: number;
  };

  /** fMP4 初始化段（ftyp + moov） */
  "fmp4:init": {
    cameraId: string;
    segment: Fmp4InitSegment;
  };

  /** fMP4 媒体段（零拷贝 moof + mdat 引用） */
  "fmp4:segment": {
    cameraId: string;
    moofData: Buffer;
    mdatData: Buffer;
  };

  /** LLM 场景分析结果 */
  "llm:scene": LlmSceneResult;

  /** 状态变更事件：检测规则更新了关联状态的值 */
  "state:changed": {
    /** 状态 ID */
    stateId: number;
    /** 状态名称 */
    stateName: string;
    /** 摄像头 ID */
    cameraId: string;
    /** 旧值 */
    oldValue: string;
    /** 新值 */
    newValue: string;
    /** 来源（manual / rule:规则ID / system） */
    source: string;
    /** 来源规则 ID */
    sourceRuleId: number;
    /** 时间戳 */
    timestamp: number;
    /** 是否需要通知用户 */
    notify: boolean;
  };

}

/** 事件名类型 */
export type EventName = keyof EventPayloads;

/** 事件回调 */
type EventCallback<T extends EventName> = (payload: EventPayloads[T]) => void;

/**
 * 类型安全的事件总线
 * 用于在模块间解耦通信：帧提取器 → 变动检测器 → API 推送
 *
 * emit 热路径无 try-catch：错误处理在 on 注册时通过包装代理完成，
 * 避免高频事件（frame/fmp4:segment）的 forEach 路径被 V8 去优化
 */
export class EventBus {
  /** 监听器列表（存储的是 error-safe 包装后的回调） */
  private listeners = new Map<EventName, Set<EventCallback<EventName>>>();

  /** 订阅事件 */
  on<T extends EventName>(event: T, callback: EventCallback<T>): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    const set = this.listeners.get(event)!;
    /** 包装为 error-safe 代理：emit 热路径无需 try-catch */
    const wrapped = ((payload: EventPayloads[T]) => {
      try {
        callback(payload);
      } catch (err) {
        console.error(`[EventBus] 事件 "${event}" 处理器异常:`, err);
      }
    }) as EventCallback<EventName>;
    set.add(wrapped);

    /** 返回取消订阅函数 */
    return () => set.delete(wrapped);
  }

  /** 触发事件（热路径：for...of 比 forEach 快 ~10%，避免每次迭代闭包创建） */
  emit<T extends EventName>(event: T, payload: EventPayloads[T]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const cb of set) {
      (cb as EventCallback<T>)(payload);
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
