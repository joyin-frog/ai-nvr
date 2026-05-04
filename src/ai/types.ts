import { type LlmConfig, type LlmModelConfig } from "./multimodal-analyzer";
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

/** AI 配置 */
export interface AiConfig {
  /** 多模态 LLM 配置（默认模型） */
  llm: LlmConfig;
  /** 可用模型列表（第一个为默认模型） */
  models: LlmModelConfig[];
  /** CLIP 零样本分类配置 */
  clip: ClipConfig;
}
