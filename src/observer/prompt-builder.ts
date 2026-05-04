import { type Observer } from "@/observer/types";

/** 单帧检测 system prompt */
const SYSTEM_PROMPT = `Is the described situation occurring? JSON only:
{"matched":false,"confidence":0.8,"description":"what you see"{signalSlot}{regionSlot}}
matched: true only if clearly occurring. confidence: 0.0-1.0. description: factual observation. When in doubt, matched=false.{signalInstructions}{regionInstructions}`;

/** 多帧检测 system prompt */
const MULTI_FRAME_SYSTEM_PROMPT = `Multiple frames. First=latest, rest=older context. Track movement over time.
Is the described situation occurring? JSON only:
{"matched":false,"confidence":0.8,"description":"what you see including changes"{signalSlot}{regionSlot}}
matched: true only if clearly occurring. confidence: 0.0-1.0. When in doubt, matched=false.{signalInstructions}{regionInstructions}`;

/** 信号评估输出 slot */
const SIGNAL_SLOT = `, "states": [{"id": <signal_id>, "value": "<new_value>"}, ...]`;

/** 信号评估指令 */
const SIGNAL_INSTRUCTIONS = `

Additionally, you MUST evaluate the following signals based on the current image and include them in the "states" array:
{signalDefinitions}

For boolean signals, use "true" or "false". For string/number signals, use the appropriate value.`;

/** 目标区域输出 slot */
const REGION_SLOT = `, "regions": [{"label": "description", "box": [x1, y1, x2, y2]}, ...]`;

/** 目标区域输出指令 */
const REGION_INSTRUCTIONS = `

Additionally, identify and locate ALL relevant objects/entities mentioned in the image. Include a "regions" array with bounding boxes.
Each region: {"label": "what this is", "box": [x1, y1, x2, y2]} where coordinates are normalized 0.0-1.0.
(x1,y1) is top-left corner, (x2,y2) is bottom-right corner.
IMPORTANT: You MUST add a bounding box for every key object/entity you can identify (people, animals, vehicles, etc.), not just background areas.`;

/** 信号信息 */
interface SignalContext {
  id: number;
  name: string;
  description: string;
  valueType: string;
  currentValue: string;
}

/** prompt 构建结果 */
export interface PromptResult {
  systemPrompt: string;
  /** 是否有上下文帧或多摄像头 */
  hasContext: boolean;
}

/**
 * Prompt 构建模块
 * 负责组装 system prompt：信号注入（当前值上下文 + 评估指令）+ 区域输出指令
 */
export class PromptBuilder {
  /**
   * 构建 system prompt
   * @param obs 观测器配置
   * @param hasContext 是否有上下文帧或多摄像头
   * @param signals 关联信号（注入当前值作为上下文，同时要求 VLM 评估并返回新值）
   * @param langInstruction 语言约束指令
   */
  build(
    obs: Observer,
    hasContext: boolean,
    signals: SignalContext[],
    langInstruction: string,
  ): PromptResult {
    /** 信号评估指令 */
    let signalSlot = "";
    let signalInstructions = "";
    if (signals.length > 0) {
      const defs = signals.map(s =>
        `- ID ${s.id}: "${s.name}" (type: ${s.valueType}, current: "${s.currentValue}")${s.description ? ` — ${s.description}` : ""}`
      ).join("\n");
      signalSlot = SIGNAL_SLOT;
      signalInstructions = SIGNAL_INSTRUCTIONS.replace("{signalDefinitions}", defs);
    }

    /** 区域输出指令 */
    const regionSlot = obs.outputRegions ? REGION_SLOT : "";
    const regionInstructions = obs.outputRegions ? REGION_INSTRUCTIONS : "";

    /** 选择 prompt 模板 */
    const basePrompt = hasContext ? MULTI_FRAME_SYSTEM_PROMPT : SYSTEM_PROMPT;
    const systemPrompt = basePrompt
      .replace("{signalSlot}", signalSlot)
      .replace("{signalInstructions}", signalInstructions)
      .replace("{regionSlot}", regionSlot)
      .replace("{regionInstructions}", regionInstructions) + langInstruction;

    return { systemPrompt, hasContext };
  }

  /** 计算 maxTokens：有信号评估/区域/多摄像头时需要更多 token */
  computeMaxTokens(obs: Observer, hasContext: boolean, baseTokens = 200): number {
    if (obs.signalIds.length > 0 || obs.outputRegions || obs.cameras.length > 1) {
      return 500;
    }
    return baseTokens;
  }
}
