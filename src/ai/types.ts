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
}

/** AI 检测事件载荷 */
export interface DetectionPayload {
  /** 摄像头 ID */
  cameraId: string;
  /** 检测时间戳 */
  timestamp: number;
  /** 检测结果列表 */
  detections: Detection[];
  /** 标注后的图片（JPEG Buffer） */
  annotatedImage: Buffer;
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
}
