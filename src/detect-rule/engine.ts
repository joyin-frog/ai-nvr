import { type EventBus } from "@/event-bus";
import { type DetectRule, DetectRuleStorage } from "@/detect-rule/storage";
import { type RuntimeConfig } from "@/runtime-config";
import { type RoiStorage } from "@/storage/roi";
import { type StateStorage } from "@/state/storage";
import sharp from "sharp";

/** 帧获取接口（由 CameraManager 实现） */
export interface FrameProvider {
  getLatestFrame(cameraId: string): Buffer | undefined;
}

/** VLM 规则检测结果 */
interface VlmRuleResult {
  /** 是否匹配用户描述 */
  matched: boolean;
  /** 置信度 0-1 */
  confidence: number;
  /** AI 描述 */
  description: string;
  /** 状态更新（可选） */
  states?: Array<{ id: number; value: string }>;
}

/** 检测规则系统 prompt */
const RULE_SYSTEM_PROMPT = `You are an intelligent surveillance camera analyzer. The user wants to detect a specific situation in the camera image.

Analyze the image carefully and determine whether the described situation is currently occurring.

You MUST respond with ONLY a JSON object in this exact format:
{"matched": true/false, "confidence": 0.0-1.0, "description": "brief description of what you observe"}

Rules:
- "matched" must be true ONLY if the described situation is clearly occurring
- "confidence" indicates how certain you are (0.0 = not sure, 1.0 = absolutely certain)
- "description" should be a factual observation in the user's language
- When in doubt, set matched to false
- Do not include any text outside the JSON object`;

/** 带状态评估的系统 prompt 后缀 */
const STATE_PROMPT_SUFFIX = `

Additionally, evaluate the following states based on the current image. Include a "states" array in your JSON response:
"states": [{"id": <state_id>, "value": "<new_value>"}, ...]

State definitions:
{stateDefinitions}

For boolean states, use "true" or "false". For string/number states, use the appropriate value.`;

/** 时段配置接口 */
interface ScheduleConfig {
  enabled: boolean;
  /** "HH:MM" 格式 */
  start: string;
  /** "HH:MM" 格式 */
  end: string;
  /** 0=周日, 1=周一, ..., 6=周六 */
  days: number[];
}

/** 全局最大并发 VLM 调用数 */
const MAX_CONCURRENT = 3;

/**
 * 检测规则引擎
 * 每条规则独立定时器，定时取帧发送给 VLM 分析
 * 支持状态评估、时段控制、per-rule 分辨率、原图保存
 */
export class DetectRuleEngine {
  private eventBus: EventBus;
  private storage: DetectRuleStorage;
  private frameProvider: FrameProvider;
  private runtimeConfig: RuntimeConfig;
  private roiStorage?: RoiStorage;
  private stateStorage?: StateStorage;

  /** 每条规则的定时器 */
  private timers = new Map<number, ReturnType<typeof setInterval>>();
  /** 每条规则上次触发时间（冷却） */
  private lastTriggerTime = new Map<number, number>();
  /** 当前并发数 */
  private concurrent = 0;
  /** 排队等待的任务 */
  private queue: Array<{ rule: DetectRule; timestamp: number }> = [];
  /** 规则缓存 */
  private rulesCache: DetectRule[] = [];
  private rulesCacheTime = 0;
  private static readonly CACHE_TTL = 30_000;
  /** 是否已启动 */
  private started = false;
  /** 快照保存回调 */
  private saveSnapshot?: (cameraId: string, timestamp: number, jpeg: Buffer) => void;

  constructor(
    eventBus: EventBus,
    storage: DetectRuleStorage,
    frameProvider: FrameProvider,
    runtimeConfig: RuntimeConfig,
    roiStorage?: RoiStorage,
    stateStorage?: StateStorage,
  ) {
    this.eventBus = eventBus;
    this.storage = storage;
    this.frameProvider = frameProvider;
    this.runtimeConfig = runtimeConfig;
    this.roiStorage = roiStorage;
    this.stateStorage = stateStorage;
  }

  /** 设置快照保存回调 */
  setSaveSnapshot(fn: (cameraId: string, timestamp: number, jpeg: Buffer) => void): void {
    this.saveSnapshot = fn;
  }

  /** 启动引擎 */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.refreshAndStartTimers();
    console.log("[DetectRuleEngine] 检测规则引擎已启动");
  }

  /** 停止引擎 */
  stop(): void {
    this.started = false;
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
    this.lastTriggerTime.clear();
    this.queue = [];
    this.concurrent = 0;
  }

  /** 规则变更时重新加载 */
  reloadRules(): void {
    this.rulesCacheTime = 0;
    if (this.started) this.refreshAndStartTimers();
  }

  /** 刷新规则缓存并重建定时器 */
  private refreshAndStartTimers(): void {
    const now = Date.now();
    if (now - this.rulesCacheTime < DetectRuleEngine.CACHE_TTL && this.rulesCache.length > 0) return;
    this.rulesCacheTime = now;

    const rules = this.storage.getEnabledRules();
    const activeIds = new Set(rules.map(r => r.id));

    /** 停止已删除/禁用的规则定时器 */
    for (const [id, timer] of this.timers) {
      if (!activeIds.has(id)) {
        clearInterval(timer);
        this.timers.delete(id);
        this.lastTriggerTime.delete(id);
      }
    }

    /** 启动新规则 */
    for (const rule of rules) {
      if (!this.timers.has(rule.id)) {
        this.startRuleTimer(rule);
      }
    }

    this.rulesCache = rules;
  }

  /** 为单条规则启动定时器 */
  private startRuleTimer(rule: DetectRule): void {
    const interval = Math.max(rule.intervalMs, 1000);
    const timer = setInterval(() => {
      this.refreshAndStartTimers();
      this.scheduleExecution(rule);
    }, interval);
    this.timers.set(rule.id, timer);
  }

  /** 调度执行（带并发控制 + 时段检查） */
  private scheduleExecution(rule: DetectRule): void {
    /** 冷却检查 */
    const lastTime = this.lastTriggerTime.get(rule.id) ?? 0;
    if (Date.now() - lastTime < rule.cooldownMs) return;

    /** 时段检查 */
    if (!this.isInSchedule(rule)) return;

    /** 帧存在检查 */
    const frame = this.frameProvider.getLatestFrame(rule.cameraId);
    if (!frame) return;

    if (this.concurrent >= MAX_CONCURRENT) {
      this.queue.push({ rule, timestamp: Date.now() });
      return;
    }

    this.executeRule(rule, frame, Date.now());
  }

  /** 检查当前时间是否在规则配置的启用时段内 */
  private isInSchedule(rule: DetectRule): boolean {
    if (!rule.schedule) return true;
    let config: ScheduleConfig;
    try {
      config = JSON.parse(rule.schedule) as ScheduleConfig;
    } catch {
      return true;
    }
    if (!config.enabled) return false;

    const now = new Date();
    /** 检查星期 */
    if (config.days.length > 0 && !config.days.includes(now.getDay())) return false;

    /** 检查时段 */
    const [startH, startM] = config.start.split(":").map(Number);
    const [endH, endM] = config.end.split(":").map(Number);
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const startMinutes = (startH ?? 0) * 60 + (startM ?? 0);
    const endMinutes = (endH ?? 23) * 60 + (endM ?? 59);

    if (startMinutes <= endMinutes) {
      return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
    }
    /** 跨午夜（如 22:00 - 06:00） */
    return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
  }

  /** 处理排队任务 */
  private processQueue(): void {
    while (this.queue.length > 0 && this.concurrent < MAX_CONCURRENT) {
      const item = this.queue.shift()!;
      /** 时段检查 */
      if (!this.isInSchedule(item.rule)) continue;
      const frame = this.frameProvider.getLatestFrame(item.rule.cameraId);
      if (frame) {
        this.executeRule(item.rule, frame, item.timestamp);
      }
    }
  }

  /** 执行单次规则检测 */
  private async executeRule(rule: DetectRule, frame: Buffer, timestamp: number): Promise<void> {
    this.concurrent++;
    try {
      const llmConfig = this.runtimeConfig.get().ai.llm;
      if (!llmConfig.enabled || !llmConfig.apiUrl || !llmConfig.model) return;

      /** 准备图片 */
      let jpeg = frame;
      if (rule.roiId > 0 && this.roiStorage) {
        jpeg = await this.cropToRoi(frame, rule.roiId) ?? frame;
      }

      /** 缩放图片（per-rule 分辨率覆盖全局配置） */
      const imageWidth = rule.imageWidth > 0 ? rule.imageWidth : llmConfig.imageWidth;
      let imageDataUrl: string;
      if (imageWidth > 0) {
        const resized = await sharp(jpeg)
          .resize(imageWidth)
          .jpeg({ quality: 80 })
          .toBuffer();
        imageDataUrl = `data:image/jpeg;base64,${resized.toString("base64")}`;
      } else {
        imageDataUrl = `data:image/jpeg;base64,${jpeg.toString("base64")}`;
      }

      /** 语言约束 */
      const lang = this.runtimeConfig.get().language;
      const langInstruction = lang.startsWith("zh") ? "\nIMPORTANT: Write the description in Chinese (中文)." : "";

      /** 状态评估 prompt（当规则关联了状态时） */
      let statePrompt = "";
      if (rule.stateIds.length > 0 && this.stateStorage) {
        const allStates = this.stateStorage.listStates();
        const linkedStates = allStates.filter(s => rule.stateIds.includes(s.id));
        if (linkedStates.length > 0) {
          const defs = linkedStates.map(s =>
            `- ID ${s.id}: "${s.name}" (type: ${s.valueType}, current: "${s.currentValue}")${s.description ? ` — ${s.description}` : ""}`
          ).join("\n");
          statePrompt = STATE_PROMPT_SUFFIX.replace("{stateDefinitions}", defs);
        }
      }

      const systemPrompt = RULE_SYSTEM_PROMPT + langInstruction + statePrompt;

      /** 调用 VLM（有关联状态时增加 max_tokens） */
      const body = {
        model: llmConfig.model,
        messages: [
          { role: "system" as const, content: systemPrompt },
          {
            role: "user" as const,
            content: [
              { type: "text" as const, text: rule.prompt },
              { type: "image_url" as const, image_url: { url: imageDataUrl } },
            ],
          },
        ],
        max_tokens: rule.stateIds.length > 0 ? 400 : 200,
        temperature: 0.1,
      };

      const response = await fetch(llmConfig.apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        console.warn(`[DetectRuleEngine] VLM API ${response.status} for rule "${rule.name}": ${text.slice(0, 100)}`);
        return;
      }

      const result = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
      };

      const content = result.choices?.[0]?.message?.content?.trim() ?? "";
      if (!content) return;

      /** 解析 VLM 返回 */
      const vlmResult = this.parseVlmResponse(content);

      /** 冷却更新 */
      this.lastTriggerTime.set(rule.id, timestamp);

      /** 写入记录 */
      this.storage.insertRecord(
        rule.id, rule.name, rule.cameraId, timestamp,
        vlmResult.description,
        vlmResult.matched,
        JSON.stringify({ confidence: vlmResult.confidence, prompt: rule.prompt }),
      );

      /** 处理状态更新 */
      if (vlmResult.states && this.stateStorage) {
        for (const stateUpdate of vlmResult.states) {
          const change = this.stateStorage.setValue(stateUpdate.id, stateUpdate.value, `rule:${rule.id}`, rule.id);
          if (change) {
            const stateDef = this.stateStorage.getState(stateUpdate.id);
            this.eventBus.emit("state:changed", {
              stateId: change.stateId,
              stateName: change.stateName,
              cameraId: change.cameraId,
              oldValue: change.oldValue,
              newValue: change.newValue,
              source: change.source,
              sourceRuleId: change.sourceRuleId,
              timestamp: change.timestamp,
              notify: stateDef?.notifyOnChange ?? false,
            });
          }
        }
      }

      if (vlmResult.matched) {
        /** 保存快照（原图优先） */
        if (this.saveSnapshot) {
          if (rule.saveOriginal) {
            /** 保存原图（未经 ROI 裁剪和缩放的帧） */
            this.saveSnapshot(rule.cameraId, timestamp, frame);
          } else {
            this.saveSnapshot(rule.cameraId, timestamp, jpeg);
          }
        }

        /** 发出事件 */
        this.eventBus.emit("detect:rule", {
          ruleId: rule.id,
          ruleName: rule.name,
          cameraId: rule.cameraId,
          timestamp,
          prompt: rule.prompt,
          result: vlmResult.description,
          confidence: vlmResult.confidence,
          detail: JSON.stringify({ confidence: vlmResult.confidence, prompt: rule.prompt }),
        });

        console.log(`[DetectRuleEngine] 规则 "${rule.name}" 匹配 (${(vlmResult.confidence * 100).toFixed(0)}%): ${vlmResult.description.slice(0, 80)}`);
      }
    } catch (err) {
      console.warn(`[DetectRuleEngine] 规则 "${rule.name}" 执行失败:`, err instanceof Error ? err.message : String(err));
    } finally {
      this.concurrent--;
      this.processQueue();
    }
  }

  /** 解析 VLM 返回的 JSON 结果 */
  private parseVlmResponse(content: string): VlmRuleResult {
    /** 尝试提取 JSON */
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const obj = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
        const states = Array.isArray(obj.states)
          ? (obj.states as Array<Record<string, unknown>>).map(s => ({
            id: typeof s.id === "number" ? s.id : 0,
            value: typeof s.value === "string" ? s.value : String(s.value),
          })).filter(s => s.id > 0)
          : undefined;
        return {
          matched: obj.matched === true,
          confidence: typeof obj.confidence === "number" ? obj.confidence : 0.5,
          description: typeof obj.description === "string" ? obj.description : content,
          states,
        };
      } catch {
        // JSON 解析失败，走 fallback
      }
    }

    /** Fallback: 关键词匹配 */
    const lower = content.toLowerCase();
    const matched = lower.includes("matched\": true") || lower.includes("matched\":true") ||
      (lower.includes("matched") && !lower.includes("matched\": false") && !lower.includes("matched\":false"));
    return { matched, confidence: 0.3, description: content };
  }

  /** 裁剪帧到 ROI 区域 */
  private async cropToRoi(frame: Buffer, roiId: number): Promise<Buffer | undefined> {
    if (!this.roiStorage) return undefined;
    const roi = this.roiStorage.getById(roiId);
    if (!roi?.points) return undefined;

    const polygon = JSON.parse(roi.points) as Array<{ x: number; y: number }>;
    if (polygon.length < 3) return undefined;

    /** 计算 bounding box */
    let minX = 1, minY = 1, maxX = 0, maxY = 0;
    for (const p of polygon) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }

    /** 扩大 10% 边距 */
    const padX = (maxX - minX) * 0.1;
    const padY = (maxY - minY) * 0.1;
    minX = Math.max(0, minX - padX);
    minY = Math.max(0, minY - padY);
    maxX = Math.min(1, maxX + padX);
    maxY = Math.min(1, maxY + padY);

    const meta = await sharp(frame).metadata();
    const w = meta.width ?? 640;
    const h = meta.height ?? 480;

    return sharp(frame)
      .extract({
        left: Math.round(minX * w),
        top: Math.round(minY * h),
        width: Math.round((maxX - minX) * w),
        height: Math.round((maxY - minY) * h),
      })
      .jpeg({ quality: 85 })
      .toBuffer();
  }
}
