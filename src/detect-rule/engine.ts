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
  /** 目标区域坐标（可选，归一化 0-1） */
  regions?: Array<{ label: string; box: { xmin: number; ymin: number; xmax: number; ymax: number } }>;
}

/** 检测规则系统 prompt */
const RULE_SYSTEM_PROMPT = `You are an intelligent surveillance camera analyzer. The user wants to detect a specific situation in the camera image.

Analyze the image carefully and determine whether the described situation is currently occurring.

You MUST respond with ONLY a JSON object in this exact format:
{"matched": true/false, "confidence": 0.0-1.0, "description": "brief description of what you observe"{stateSlot}{regionSlot}}

Rules:
- "matched" must be true ONLY if the described situation is clearly occurring
- "confidence" indicates how certain you are (0.0 = not sure, 1.0 = absolutely certain)
- "description" should be a factual observation in the user's language
- When in doubt, set matched to false
- Do not include any text outside the JSON object
{stateInstructions}{regionInstructions}`;

/** 状态评估指令片段（仅当关联了状态时注入） */
const STATE_SLOT = `, "states": [{"id": <state_id>, "value": "<new_value>"}, ...]`;
const STATE_INSTRUCTIONS = `

Additionally, you MUST evaluate the following states based on the current image and include them in the "states" array:
{stateDefinitions}

For boolean states, use "true" or "false". For string/number states, use the appropriate value.`;

/** 目标区域输出指令片段（仅当 outputRegions=true 时注入） */
const REGION_SLOT = `, "regions": [{"label": "description", "box": [x1, y1, x2, y2]}, ...]`;
const REGION_INSTRUCTIONS = `

Additionally, identify and locate ALL relevant objects/entities mentioned in the image. Include a "regions" array with bounding boxes.
Each region: {"label": "what this is", "box": [x1, y1, x2, y2]} where coordinates are normalized 0.0-1.0.
(x1,y1) is top-left corner, (x2,y2) is bottom-right corner.
IMPORTANT: You MUST add a bounding box for every key object/entity you can identify (people, animals, vehicles, etc.), not just background areas.`;

/** 时段配置接口（预计算分钟数，避免每次 split） */
interface ScheduleConfig {
  enabled: boolean;
  /** 0=周日, 1=周一, ..., 6=周六 */
  days: number[];
  /** 开始时间（一天中的分钟数，预计算） */
  startMinutes: number;
  /** 结束时间（一天中的分钟数，预计算） */
  endMinutes: number;
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
  /** 状态定义缓存（避免每次 executeRule 都查 SQLite） */
  private statesCache: import("@/state/storage").StateDef[] = [];
  private statesCacheTime = 0;
  /** schedule 解析缓存（rule.schedule -> ScheduleConfig | null） */
  private scheduleCache = new Map<string, ScheduleConfig | null>();
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
    this.statesCache = [];
    this.statesCacheTime = 0;
    this.scheduleCache.clear();
  }

  /** 规则变更时重新加载 */
  reloadRules(): void {
    this.rulesCacheTime = 0;
    this.statesCacheTime = 0;
    this.scheduleCache.clear();
    if (this.started) this.refreshAndStartTimers();
  }

  /** 获取缓存的状态列表（30 秒 TTL） */
  private getCachedStates(): import("@/state/storage").StateDef[] {
    if (!this.stateStorage) return [];
    const now = Date.now();
    if (now - this.statesCacheTime < DetectRuleEngine.CACHE_TTL) return this.statesCache;
    this.statesCache = this.stateStorage.listStates();
    this.statesCacheTime = now;
    return this.statesCache;
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
    let config = this.scheduleCache.get(rule.schedule);
    if (config === undefined) {
      try {
        const raw = JSON.parse(rule.schedule) as { enabled?: boolean; start?: string; end?: string; days?: number[] };
        const [sH, sM] = (raw.start ?? "00:00").split(":").map(Number);
        const [eH, eM] = (raw.end ?? "23:59").split(":").map(Number);
        config = {
          enabled: raw.enabled !== false,
          days: raw.days ?? [],
          startMinutes: (sH ?? 0) * 60 + (sM ?? 0),
          endMinutes: (eH ?? 23) * 60 + (eM ?? 59),
        };
      } catch {
        config = null;
      }
      this.scheduleCache.set(rule.schedule, config);
    }
    if (!config) return true;
    if (!config.enabled) return false;

    const now = new Date();
    if (config.days.length > 0 && !config.days.includes(now.getDay())) return false;

    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    if (config.startMinutes <= config.endMinutes) {
      return currentMinutes >= config.startMinutes && currentMinutes <= config.endMinutes;
    }
    return currentMinutes >= config.startMinutes || currentMinutes <= config.endMinutes;
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
        /** sharp 管线：resize + jpeg 编码一步完成，避免中间 Buffer 分配 */
        const resized = await sharp(jpeg, { failOn: "none" })
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
      let stateSlot = "";
      let stateInstructions = "";
      if (rule.stateIds.length > 0 && this.stateStorage) {
        const allStates = this.getCachedStates();
        const linkedStates = allStates.filter(s => rule.stateIds.includes(s.id));
        if (linkedStates.length > 0) {
          const defs = linkedStates.map(s =>
            `- ID ${s.id}: "${s.name}" (type: ${s.valueType}, current: "${s.currentValue}")${s.description ? ` — ${s.description}` : ""}`
          ).join("\n");
          stateSlot = STATE_SLOT;
          stateInstructions = STATE_INSTRUCTIONS.replace("{stateDefinitions}", defs);
        }
      }

      /** 目标区域输出 prompt（当 outputRegions 启用时） */
      const regionSlot = rule.outputRegions ? REGION_SLOT : "";
      const regionInstructions = rule.outputRegions ? REGION_INSTRUCTIONS : "";

      const systemPrompt = RULE_SYSTEM_PROMPT
        .replace("{stateSlot}", stateSlot)
        .replace("{stateInstructions}", stateInstructions)
        .replace("{regionSlot}", regionSlot)
        .replace("{regionInstructions}", regionInstructions) + langInstruction;

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
        max_tokens: (rule.stateIds.length > 0 || rule.outputRegions) ? 500 : 200,
        temperature: 0.1,
      };

      /** AbortController 超时保护：15 秒后自动中断，防止单规则卡死整个引擎 */
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);

      const response = await fetch(llmConfig.apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout));

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
        JSON.stringify({ confidence: vlmResult.confidence, prompt: rule.prompt, rawResponse: content, regions: vlmResult.regions }),
      );

      /** 处理状态更新（跳过已禁用的状态） */
      if (vlmResult.states && this.stateStorage) {
        for (const stateUpdate of vlmResult.states) {
          const stateDef = this.stateStorage.getState(stateUpdate.id);
          if (!stateDef?.enabled) continue;
          const change = this.stateStorage.setValue(stateUpdate.id, stateUpdate.value, `rule:${rule.id}`, rule.id);
          if (change) {
            this.eventBus.emit("state:changed", {
              stateId: change.stateId,
              stateName: change.stateName,
              cameraId: change.cameraId,
              oldValue: change.oldValue,
              newValue: change.newValue,
              source: change.source,
              sourceRuleId: change.sourceRuleId,
              timestamp: change.timestamp,
              notify: stateDef.notifyOnChange,
            });
          }
        }
      }

      if (vlmResult.matched || rule.outputRegions) {
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
          regions: vlmResult.regions,
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

        /** 解析目标区域坐标 */
        const regions = this.parseRegions(obj.regions);

        return {
          matched: obj.matched === true,
          confidence: typeof obj.confidence === "number" ? obj.confidence : 0.5,
          description: typeof obj.description === "string" ? obj.description : content,
          states,
          regions: regions.length > 0 ? regions : undefined,
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

  /** 解析 VLM 返回的 regions 数组，支持数组格式 box 和对象格式 box */
  private parseRegions(raw: unknown): Array<{ label: string; box: { xmin: number; ymin: number; xmax: number; ymax: number } }> {
    if (!Array.isArray(raw)) return [];
    const result: Array<{ label: string; box: { xmin: number; ymin: number; xmax: number; ymax: number } }> = [];
    for (const item of raw as Array<Record<string, unknown>>) {
      const label = typeof item.label === "string" ? item.label : "unknown";
      const box = item.box;
      let xmin: number | undefined, ymin: number | undefined, xmax: number | undefined, ymax: number | undefined;

      if (Array.isArray(box) && box.length >= 4) {
        /** 数组格式 [x1, y1, x2, y2] */
        xmin = this.clamp01(Number(box[0]));
        ymin = this.clamp01(Number(box[1]));
        xmax = this.clamp01(Number(box[2]));
        ymax = this.clamp01(Number(box[3]));
      } else if (box && typeof box === "object" && !Array.isArray(box)) {
        /** 对象格式 {xmin, ymin, xmax, ymax} */
        const b = box as Record<string, unknown>;
        xmin = this.clamp01(Number(b.xmin ?? b.x1 ?? 0));
        ymin = this.clamp01(Number(b.ymin ?? b.y1 ?? 0));
        xmax = this.clamp01(Number(b.xmax ?? b.x2 ?? 0));
        ymax = this.clamp01(Number(b.ymax ?? b.y2 ?? 0));
      }

      if (xmin !== undefined && ymin !== undefined && xmax !== undefined && ymax !== undefined && xmax > xmin && ymax > ymin) {
        result.push({ label, box: { xmin, ymin, xmax, ymax } });
      }
    }
    return result;
  }

  /** 坐标 clamp 到 [0, 1] */
  private clamp01(v: number): number {
    return Math.max(0, Math.min(1, v));
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
