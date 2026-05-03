import { type LlmConfig } from "./multimodal-analyzer";
import { type ClipConfig } from "./clip-service";

/** 单个检测结果 */
export interface Detection {
  /** 检测到的物体类别（如 person, car, dog） */
  label: string;
  /** 置信度（0-1） */
  score: number;
  /** 边界框坐标（归一化 0-1） */
  box: {
    xmin: number;
    ymin: number;
    xmax: number;
    ymax: number;
  };
  /** 追踪 ID（跨帧保持一致，可选） */
  trackId?: number;
  /** 运动速度向量（归一化坐标/帧，可选） */
  velocity?: { dx: number; dy: number };
  /** 用户自定义名称（外观匹配或手动命名） */
  trackName?: string;
  /** 主色调（十六进制颜色，如 #FF6B6B） */
  dominantColor?: string;
  /** CLIP 零样本分类的语义标签（如 "a black dog", "a person walking"） */
  semanticLabel?: string;
  /** VLM 检测的姿态/朝向（如 standing, walking, facing-camera） */
  pose?: string;
}

/** AI 检测事件载荷 */
export interface DetectionPayload {
  /** 摄像头 ID */
  cameraId: string;
  /** 检测时间戳 */
  timestamp: number;
  /** 检测结果列表 */
  detections: Detection[];
}

/** 检测模式：motion = 变动触发，continuous = 连续检测 */
export type DetectMode = "motion" | "continuous";

/** AI 配置 */
export interface AiConfig {
  /** 是否启用 AI 检测 */
  enabled: boolean;
  /** 模型名称（Hugging Face Hub 上的模型 ID） */
  model: string;
  /** 置信度阈值（0-1） */
  threshold: number;
  /** 最大检测数量 */
  maxDetections: number;
  /** AI 推理输入宽度（0 = 使用原始帧分辨率） */
  inputWidth: number;
  /** 是否在画面上显示检测框（默认 true） */
  showBoxes: boolean;
  /** 检测模式：motion = 变动触发，continuous = 连续检测（默认 motion） */
  mode: DetectMode;
  /** 连续检测间隔（毫秒，仅 continuous 模式，默认 1000） */
  interval: number;
  /** 关注的目标标签（只有这些标签才触发通知事件） */
  importantLabels: string[];
  /** 自动匹配关联阈值（0-1，低于此值自动关联已命名目标，0 = 禁用自动匹配） */
  autoMatchThreshold: number;
  /** 速度告警阈值（归一化坐标/帧，0 = 禁用速度告警，默认 0.02） */
  speedThreshold: number;
  /** 徘徊检测阈值（秒，目标在 ROI 内来回移动超过此时间触发，0 = 禁用） */
  loiterThreshold: number;
  /** 多模态 LLM 配置 */
  llm: LlmConfig;
  /** CLIP 零样本分类配置 */
  clip: ClipConfig;
}
