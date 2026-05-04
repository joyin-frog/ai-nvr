/** 摄像头源配置 */
export interface CameraSource {
  /** 摄像头 ID */
  cameraId: string;
  /** 裁剪区域 ID（0=不裁剪，发送完整画面） */
  roiId: number;
  /** 取多少秒前的帧（0=当前帧） */
  offsetSec: number;
  /** 视频片段配置（存在时从录制文件抽帧，而非取单帧） */
  videoClip?: {
    /** 开始偏移秒数（正值=过去，如 30=触发前30秒） */
    startOffsetSec: number;
    /** 结束偏移秒数（如 5=触发前5秒） */
    endOffsetSec: number;
    /** 抽帧配置 */
    extraction: {
      /** 模式：fps=按帧率抽帧，total=均匀抽指定总数 */
      mode: "fps" | "total";
      /** fps 模式时每秒帧数（1-5） */
      fps?: number;
      /** total 模式时总帧数（1-20） */
      totalFrames?: number;
    };
  };
}

/** 目标区域坐标（归一化 0-1） */
export interface Region {
  label: string;
  box: { xmin: number; ymin: number; xmax: number; ymax: number };
}

/** 观测器（原检测规则） */
export interface Observer {
  id: number;
  /** 观测器名称 */
  name: string;
  /** 摄像头列表（第一个为主摄像头，决定检测触发时机） */
  cameras: CameraSource[];
  /** 用户提示词 */
  prompt: string;
  /** 检测间隔（毫秒） */
  intervalMs: number;
  /** 冷却时间（毫秒） */
  cooldownMs: number;
  /** 是否启用 */
  enabled: boolean;
  /** AI 推理分辨率（0=使用全局配置） */
  imageWidth: number;
  /** 关联信号：VLM 评估这些信号的当前值并更新 */
  signalIds: number[];
  /** 时段配置 JSON（空字符串=始终启用） */
  schedule: string;
  /** 匹配时是否保存原图 */
  saveOriginal: boolean;
  /** 指定使用的模型 ID（空字符串=使用默认模型） */
  modelId: string;
  /** 是否输出目标区域坐标 */
  outputRegions: boolean;
  /** 参考图片路径列表 */
  refImages: string[];
}

/** VLM 分析结果 */
export interface ObservationResult {
  /** 是否匹配用户描述 */
  matched: boolean;
  /** 置信度 0-1 */
  confidence: number;
  /** AI 描述 */
  description: string;
  /** AI 完整原始返回文本（用于调试展示） */
  rawContent?: string;
  /** 信号评估结果（signalIds 对应的值） */
  signalUpdates?: Array<{ id: number; value: string }>;
  /** 目标区域坐标 */
  regions?: Region[];
}

/** 观测事件载荷 */
export interface ObservationEvent {
  /** 观测器 ID */
  observerId: number;
  /** 观测器名称 */
  observerName: string;
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
  regions?: Region[];
}

/** 帧获取接口（由 CameraManager 实现） */
export interface FrameProvider {
  getLatestFrame(cameraId: string): Buffer | undefined;
}

/** 帧准备结果 */
export interface PreparedFrames {
  /** 主摄像头图片 data URL */
  primaryDataUrl: string;
  /** 是否有上下文帧 */
  hasContext: boolean;
  /** user content 数组（文本 + 图片，可直接发送给 VLM） */
  userContent: Array<{ type: string; text?: string; image_url?: { url: string } }>;
  /** 各摄像头原始帧（用于匹配后保存快照） */
  cameraFrames: Map<string, { original: Buffer; processed: Buffer }>;
}
