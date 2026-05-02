import { ObjectTracker, initNextTrackId } from "./tracker";
import { type Detection, type DetectMode } from "./types";
import { type Annotator } from "./annotator";
import { type EventBus } from "@/event-bus";
import { type RuntimeConfig } from "@/runtime-config";
import { TrackStorage } from "@/storage/tracks";
import { type TrackLabelStorage } from "@/storage/track-labels";
import { type TrackTrajectoryStorage } from "@/storage/track-trajectory";
import { ClipService } from "./clip-service";
import sharp from "sharp";

/** VLM 分析结果（从 JSON 响应中解析） */
interface VlmDetection {
  /** 目标标签（person/car/dog 等） */
  label: string;
  /** 置信度（0-1） */
  score: number;
  /** 可选的边界框（归一化 0-1），VLM 可能无法精确输出 */
  box?: { xmin: number; ymin: number; xmax: number; ymax: number };
  /** VLM 生成的语义描述 */
  description?: string;
}

/** VLM API 返回的结构化结果 */
interface VlmAnalysisResult {
  /** 检测到的目标列表 */
  objects: VlmDetection[];
  /** 场景整体描述 */
  scene: string;
  /** 推理耗时 ms */
  inferMs: number;
}

/** VLM 检测 prompt（要求输出结构化 JSON，包含 bbox_2d 坐标） */
const VLM_SYSTEM_PROMPT = `You are a real-time surveillance camera analyzer. Detect ALL visible objects in the image.

For each object, output a JSON object with:
- "bbox_2d": [x1, y1, x2, y2] in PIXELS (tight bounding box around the object)
- "label": one of: person, car, truck, bus, motorcycle, bicycle, dog, cat, bird, bag, box, other
- "count": always 1 (each bbox is one object)
- "description": short description including color, size, activity, distinctive features

Output a JSON array ONLY. No markdown, no explanation.
Example: [{"bbox_2d": [120, 45, 280, 400], "label": "person", "count": 1, "description": "person in black jacket walking"}]

Rules:
- Draw the TIGHTEST possible bounding box around each object
- If multiple objects of the same type exist, create separate entries
- Include partially visible objects at image edges
- Never return an empty array if any object is visible`;

/**
 * AI 目标检测器
 * 使用 VLM（视觉语言模型）API 进行帧分析，替代本地 YOLO 推理
 * 保留 ByteTrack 追踪、CLIP 分类、外观匹配等下游能力
 */
export class AiDetector {
  /** 是否已初始化 */
  private initialized = false;
  /** 连续检测定时器 */
  private continuousTimer: ReturnType<typeof setInterval> | null = null;
  /** 每个摄像头最新帧缓存（用于连续检测） */
  private latestFrames = new Map<string, { data: Buffer; timestamp: number }>();
  /** 帧事件取消订阅函数 */
  private unsubFrame: (() => void) | null = null;
  /** 变动触发模式的取消订阅函数 */
  private unsubMotion: (() => void) | null = null;
  /** 待检测摄像头队列 */
  private detectQueue: string[] = [];
  /** 每个摄像头最近一次完成推理的时间（用于跳过过密请求） */
  private lastDetectTime = new Map<string, number>();
  /** 上一次检测结果指纹（用于去重通知） */
  private lastDetectFingerprint = new Map<string, string>();
  /** 每个摄像头的连续空检测计数（用于智能降频） */
  private emptyDetectStreak = new Map<string, number>();
  /** 智能降频：连续空检测达到此值时间隔翻倍 */
  private static readonly IDLE_SLOWDOWN_THRESHOLD = 5;
  /** 最大降频倍数 */
  private static readonly MAX_IDLE_MULTIPLIER = 4;
  /** 每个摄像头的目标追踪器 */
  private trackers = new Map<string, ObjectTracker>();
  /** trackName 缓存：cameraId:trackId -> name，定期刷新 */
  private trackNameCache = new Map<string, string>();
  /** dominantColor 缓存：trackId -> color，随 trackNameCache 同步刷新 */
  private trackColorCache = new Map<number, string>();
  /** 缓存刷新定时器 */
  private trackNameCacheTimer: ReturnType<typeof setInterval> | null = null;

  /** CLIP 语义标签缓存：trackId → semanticLabel */
  private semanticLabelCache = new Map<number, string>();

  /** 接近检测：最近一次触发过的目标对（避免重复触发），key = "smallerId:largerId" */
  private approachCooldown = new Map<string, number>();
  /** 接近事件冷却时间 ms */
  private static readonly APPROACH_COOLDOWN_MS = 10_000;
  /** 接近距离阈值（归一化 0-1） */
  private static readonly APPROACH_DISTANCE_THRESHOLD = 0.15;

  /** 每个摄像头正在分析中 */
  private analyzing = new Set<string>();

  constructor(
    private runtimeConfig: RuntimeConfig,
    private eventBus: EventBus,
    private annotator: Annotator,
    modelCacheDir: string,
    private trackStorage?: TrackStorage,
    private trackLabelStorage?: TrackLabelStorage,
    private trajectoryStorage?: TrackTrajectoryStorage,
    private clipService?: ClipService,
  ) {
    /** modelCacheDir 在 VLM 模式下不再使用（YOLO Worker 已移除），但保留参数兼容性 */
    void modelCacheDir;
  }

  /** 注入 MotionDetector 引用（用于查询最新帧差异比率，跳过静态帧推理） */
  private motionDetector: { getLatestRatio(cameraId: string): number } | null = null;

  /** 注入 Recorder 引用（用于从帧缓冲区取上下文帧） */
  private recorder: { getContextFrames(cameraId: string, now: number, intervalMs: number, maxFrames?: number): Array<{ data: Buffer; timestamp: number }> } | null = null;

  setMotionDetector(md: { getLatestRatio(cameraId: string): number }): void {
    this.motionDetector = md;
  }

  setRecorder(rec: { getContextFrames(cameraId: string, now: number, intervalMs: number, maxFrames?: number): Array<{ data: Buffer; timestamp: number }> }): void {
    this.recorder = rec;
  }

  /** 异步初始化 */
  async init(): Promise<void> {
    const config = this.runtimeConfig.get().ai;
    if (!config.enabled) {
      console.log("[AiDetector] AI 检测已禁用");
      return;
    }

    /** 验证 VLM API 可用性 */
    const llmConfig = config.llm;
    if (!llmConfig.apiUrl || !llmConfig.model) {
      console.warn("[AiDetector] VLM API 未配置（api_url 或 model 为空），AI 检测无法启动");
      return;
    }

    console.log(`[AiDetector] VLM 模式: ${llmConfig.model} @ ${llmConfig.apiUrl}`);
    this.initialized = true;

    /** 从持久化存储恢复 trackId 计数器，避免重启后 ID 重叠导致命名失效 */
    if (this.trackStorage) {
      const maxId = this.trackStorage.getMaxTrackId();
      if (maxId > 0) {
        initNextTrackId(maxId);
        console.log(`[AiDetector] trackId 计数器已恢复: nextId=${maxId + 1}`);
      }
    }

    /** 启动检测模式 */
    this.startDetection();

    /** 定期刷新 trackName 和 trackColor 缓存（30秒） */
    if (this.trackLabelStorage) {
      this.trackNameCacheTimer = setInterval(() => {
        this.trackNameCache.clear();
        this.trackColorCache.clear();
      }, 30000);
    }
  }

  /** 摄像头离线清理取消订阅 */
  private unsubCameraOffline: (() => void) | null = null;

  /** 根据配置启动检测模式 */
  private startDetection(): void {
    const config = this.runtimeConfig.get().ai;

    /** 摄像头离线时清理该摄像头的所有缓存 */
    this.unsubCameraOffline = this.eventBus.on("camera:offline", ({ cameraId }) => {
      this.latestFrames.delete(cameraId);
      this.lastDetectTime.delete(cameraId);
      this.lastDetectFingerprint.delete(cameraId);
      this.trackers.delete(cameraId);
      this.analyzing.delete(cameraId);
      this.trackNameCache.forEach((_v, k) => { if (k.startsWith(`${cameraId}:`)) this.trackNameCache.delete(k); });
    });

    if (config.mode === "continuous") {
      /** 帧驱动模式：每收到新帧时检查间隔，满足条件立即推理 */
      this.unsubFrame = this.eventBus.on("detect:frame", ({ cameraId, data, timestamp }) => {
        this.latestFrames.set(cameraId, { data, timestamp });
        const camInterval = this.getEffectiveInterval(cameraId);
        const lastTime = this.lastDetectTime.get(cameraId) ?? 0;
        if (timestamp - lastTime >= camInterval * 0.8) {
          this.detect(cameraId, data, timestamp).catch(err => {
            console.error(`[AiDetector] 检测失败 [${cameraId}]:`, err);
          });
        }
      });

      /** 定时器兜底：防止帧事件丢失时漏检 */
      this.startContinuousLoop(config.interval);
      console.log(`[AiDetector] 连续检测模式（帧驱动），间隔 ${config.interval}ms`);
    } else {
      this.unsubMotion = this.eventBus.on("motion", ({ cameraId, data, timestamp }) => {
        this.detect(cameraId, data, timestamp);
      });
      console.log("[AiDetector] 变动触发检测模式");
    }
  }

  /** 启动连续检测循环 */
  private baseInterval = 0;
  private globalIdleBoosted = false;
  private startContinuousLoop(interval: number): void {
    if (this.continuousTimer) clearInterval(this.continuousTimer);
    this.baseInterval = interval;
    this.continuousTimer = setInterval(() => {
      const now = Date.now();
      for (const [cameraId, frame] of this.latestFrames) {
        const camInterval = this.getEffectiveInterval(cameraId);
        if (now - frame.timestamp > camInterval * 3) continue;
        if (!this.detectQueue.includes(cameraId)) {
          this.detectQueue.push(cameraId);
        }
      }
      this.processQueue();
      this.adjustGlobalInterval();
    }, interval);
  }

  /** 动态调整全局定时器：所有摄像头深度 idle 时降频，有活动时恢复 */
  private adjustGlobalInterval(): void {
    if (!this.continuousTimer || this.baseInterval === 0) return;
    const allDeepIdle = this.latestFrames.size > 0 && [...this.emptyDetectStreak.values()].every(
      s => s >= AiDetector.IDLE_SLOWDOWN_THRESHOLD * 2,
    );
    if (allDeepIdle && !this.globalIdleBoosted) {
      clearInterval(this.continuousTimer);
      this.continuousTimer = setInterval(() => {
        const now = Date.now();
        for (const [cameraId, frame] of this.latestFrames) {
          const camInterval = this.getEffectiveInterval(cameraId);
          if (now - frame.timestamp > camInterval * 3) continue;
          if (!this.detectQueue.includes(cameraId)) {
            this.detectQueue.push(cameraId);
          }
        }
        this.processQueue();
        this.adjustGlobalInterval();
      }, this.baseInterval * 2);
      this.globalIdleBoosted = true;
    } else if (!allDeepIdle && this.globalIdleBoosted) {
      clearInterval(this.continuousTimer);
      this.continuousTimer = setInterval(() => {
        const now = Date.now();
        for (const [cameraId, frame] of this.latestFrames) {
          const camInterval = this.getEffectiveInterval(cameraId);
          if (now - frame.timestamp > camInterval * 3) continue;
          if (!this.detectQueue.includes(cameraId)) {
            this.detectQueue.push(cameraId);
          }
        }
        this.processQueue();
        this.adjustGlobalInterval();
      }, this.baseInterval);
      this.globalIdleBoosted = false;
    }
  }

  /** 获取有效检测间隔（考虑智能降频） */
  private getEffectiveInterval(cameraId: string): number {
    const baseInterval = this.runtimeConfig.getAiInterval(cameraId);
    const streak = this.emptyDetectStreak.get(cameraId) ?? 0;
    if (streak < AiDetector.IDLE_SLOWDOWN_THRESHOLD) return baseInterval;
    const multiplier = Math.min(
      1 + Math.floor((streak - AiDetector.IDLE_SLOWDOWN_THRESHOLD) / AiDetector.IDLE_SLOWDOWN_THRESHOLD),
      AiDetector.MAX_IDLE_MULTIPLIER,
    );
    return baseInterval * multiplier;
  }

  private processQueue(): void {
    const now = Date.now();
    const batch = this.detectQueue.splice(0);
    for (const cameraId of batch) {
      const camInterval = this.getEffectiveInterval(cameraId);
      const frame = this.latestFrames.get(cameraId);
      if (!frame) continue;
      if (now - frame.timestamp > camInterval * 3) continue;
      const lastTime = this.lastDetectTime.get(cameraId) ?? 0;
      if (now - lastTime < camInterval * 0.8) continue;
      this.lastDetectTime.set(cameraId, now);
      this.detect(cameraId, frame.data, frame.timestamp).catch(err => {
        console.error(`[AiDetector] 检测失败 [${cameraId}]:`, err);
      });
    }
  }

  /** 停止连续检测 */
  private stopContinuousLoop(): void {
    if (this.continuousTimer) {
      clearInterval(this.continuousTimer);
      this.continuousTimer = null;
    }
    if (this.unsubFrame) {
      this.unsubFrame();
      this.unsubFrame = null;
    }
    if (this.unsubMotion) {
      this.unsubMotion();
      this.unsubMotion = null;
    }
    if (this.unsubCameraOffline) {
      this.unsubCameraOffline();
      this.unsubCameraOffline = null;
    }
    this.latestFrames.clear();
    this.detectQueue = [];
    this.lastDetectTime.clear();
  }

  /** 运行时切换检测模式 */
  setMode(mode: DetectMode, interval?: number): void {
    const ai = this.runtimeConfig.get().ai;
    if (ai.mode === mode && (mode === "motion" || ai.interval === interval)) return;

    this.stopContinuousLoop();

    const updatedInterval = interval ?? ai.interval;
    this.runtimeConfig.patch({ ai: { ...ai, mode, interval: updatedInterval } });

    this.startDetection();
  }

  /** 获取当前模型信息 */
  getModelInfo(): { model: string; loading: boolean; initialized: boolean } {
    const llmConfig = this.runtimeConfig.get().ai.llm;
    return { model: llmConfig.model || "vlm", loading: false, initialized: this.initialized };
  }

  /** 兼容旧的 reloadModel API（VLM 模式下为空操作） */
  async reloadModel(): Promise<{ ok: boolean; model: string; error?: string }> {
    const llmConfig = this.runtimeConfig.get().ai.llm;
    return { ok: true, model: llmConfig.model || "vlm" };
  }

  /** 静态帧跳过：motion ratio 低于此阈值且上一帧也是空结果时跳过推理 */
  private static readonly STATIC_RATIO_THRESHOLD = 0.005;

  /** 调用 VLM API 分析帧画面 */
  private async analyzeWithVlm(jpeg: Buffer, cameraId: string, timestamp: number): Promise<VlmAnalysisResult> {
    const t0 = performance.now();
    const aiConfig = this.runtimeConfig.get().ai;
    const llmConfig = aiConfig.llm;

    /** 缩放图片减少传输和推理开销 */
    const resizeImage = async (img: Buffer): Promise<string> => {
      if (llmConfig.imageWidth > 0) {
        const resized = await sharp(img)
          .resize(llmConfig.imageWidth)
          .jpeg({ quality: 80 })
          .toBuffer();
        return `data:image/jpeg;base64,${resized.toString("base64")}`;
      }
      return `data:image/jpeg;base64,${img.toString("base64")}`;
    };

    /** 根据用户语言配置注入语言约束 */
    const lang = this.runtimeConfig.get().language;
    const langInstruction = lang.startsWith("zh") ? "\nIMPORTANT: Write ALL descriptions in Chinese (中文)." : "";
    const systemPrompt = VLM_SYSTEM_PROMPT + langInstruction;

    /** 构建 user content：当前帧 + 上下文帧 */
    const imageDataUrl = await resizeImage(jpeg);
    const userContent: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
      { type: "text", text: "Analyze this surveillance camera image (latest frame):" },
      { type: "image_url", image_url: { url: imageDataUrl } },
    ];

    /** 从帧缓冲区取上下文帧 */
    if (this.recorder && llmConfig.contextIntervalMs > 0) {
      const contextFrames = this.recorder.getContextFrames(cameraId, timestamp, llmConfig.contextIntervalMs);
      for (let i = 0; i < contextFrames.length; i++) {
        const ctxUrl = await resizeImage(contextFrames[i]!.data);
        const agoSec = Math.round((timestamp - contextFrames[i]!.timestamp) / 1000);
        userContent.push({
          type: "text",
          text: `Context frame from ${agoSec}s ago:`,
        });
        userContent.push({ type: "image_url", image_url: { url: ctxUrl } });
      }
    }

    const body = {
      model: llmConfig.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      max_tokens: llmConfig.maxTokens,
      temperature: 0.3,
    };

    const apiUrl = llmConfig.apiUrl.endsWith("/chat/completions")
      ? llmConfig.apiUrl
      : `${llmConfig.apiUrl.replace(/\/$/, "")}/v1/chat/completions`;

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`VLM API ${response.status}: ${text.slice(0, 200)}`);
    }

    const result = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = result.choices?.[0]?.message?.content?.trim() ?? "";
    const inferMs = performance.now() - t0;

    /** 解析 VLM 输出为结构化结果 */
    return this.parseVlmResponse(content, inferMs);
  }

  /** 解析 VLM 返回的 JSON（支持数组格式和对象格式） */
  private parseVlmResponse(content: string, inferMs: number): VlmAnalysisResult {
    /** 提取 JSON */
    let jsonStr = content;
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1]!.trim();
    }

    /** 尝试找到 JSON 边界 */
    const arrayStart = jsonStr.indexOf("[");
    const objStart = jsonStr.indexOf("{");

    let parsed: unknown;
    if (arrayStart >= 0 && (objStart < 0 || arrayStart < objStart)) {
      /** 数组格式：[{"bbox_2d": [...], "label": "person", ...}, ...] */
      const end = jsonStr.lastIndexOf("]");
      if (end > arrayStart) {
        jsonStr = jsonStr.slice(arrayStart, end + 1);
      }
    } else if (objStart >= 0) {
      /** 对象格式：{"objects": [...], "scene": "..."} */
      const end = jsonStr.lastIndexOf("}");
      if (end > objStart) {
        jsonStr = jsonStr.slice(objStart, end + 1);
      }
    }

    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      return { objects: [], scene: content, inferMs };
    }

    /** 提取对象列表和场景描述 */
    let rawObjects: Array<Record<string, unknown>> = [];
    let scene = "";

    if (Array.isArray(parsed)) {
      /** 直接是数组格式 */
      rawObjects = parsed;
    } else if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      if (Array.isArray(obj.objects)) {
        rawObjects = obj.objects;
      }
      if (typeof obj.scene === "string") scene = obj.scene;
    }

    /** 获取图片尺寸（用于 bbox 像素→归一化转换） */
    const imageWidth = this.runtimeConfig.get().ai.inputWidth || 640;
    const imageHeight = Math.round(imageWidth * 9 / 16); /** 假设 16:9 */

    const validLabels = this.runtimeConfig.get().ai.importantLabels;
    const objects: VlmDetection[] = [];

    for (const raw of rawObjects) {
      const label = typeof raw.label === "string" ? raw.label : "";
      if (!label) continue;

      /** 标签过滤 */
      if (validLabels.length > 0 && !validLabels.includes(label.toLowerCase()) && !validLabels.includes(label)) continue;

      /** 解析 bbox_2d 像素坐标 → 归一化 0-1 */
      let box: VlmDetection["box"];
      if (Array.isArray(raw.bbox_2d) && raw.bbox_2d.length >= 4) {
        const coords = raw.bbox_2d.map(Number);
        if (coords.every(c => !isNaN(c))) {
          box = {
            xmin: Math.max(0, Math.min(1, coords[0]! / imageWidth)),
            ymin: Math.max(0, Math.min(1, coords[1]! / imageHeight)),
            xmax: Math.max(0, Math.min(1, coords[2]! / imageWidth)),
            ymax: Math.max(0, Math.min(1, coords[3]! / imageHeight)),
          };
        }
      }

      const score = typeof raw.score === "number"
        ? Math.min(1, Math.max(0, raw.score))
        : 0.8; /** VLM 不一定输出 score，给默认值 */

      objects.push({
        label: label.toLowerCase(),
        score,
        box,
        description: typeof raw.description === "string" ? raw.description : undefined,
      });
    }

    return {
      objects: objects.slice(0, this.runtimeConfig.get().ai.maxDetections),
      scene,
      inferMs,
    };
  }

  /** 执行目标检测（调用 VLM API） */
  private async detect(cameraId: string, jpeg: Buffer, timestamp: number): Promise<void> {
    if (!this.initialized) return;

    const aiConfig = this.runtimeConfig.get().ai;
    if (!aiConfig.enabled) return;

    /** 防止同一摄像头并发分析 */
    if (this.analyzing.has(cameraId)) return;
    this.analyzing.add(cameraId);

    /** 静态帧跳过：ratio 极低且上一帧也是空结果 → 跳过推理 */
    if (this.motionDetector && aiConfig.mode === "continuous") {
      const ratio = this.motionDetector.getLatestRatio(cameraId);
      const streak = this.emptyDetectStreak.get(cameraId) ?? 0;
      if (ratio < AiDetector.STATIC_RATIO_THRESHOLD && streak >= AiDetector.IDLE_SLOWDOWN_THRESHOLD) {
        this.emptyDetectStreak.set(cameraId, streak + 1);
        this.lastDetectTime.set(cameraId, Date.now());
        this.annotator.setLatestFrame(cameraId, jpeg, []);
        this.eventBus.emit("detect", {
          cameraId,
          timestamp,
          detections: [],
          frameImage: jpeg,
          changed: false,
          inferMs: 0,
        });
        this.analyzing.delete(cameraId);
        return;
      }
    }

    /** 更新最后推理时间 */
    this.lastDetectTime.set(cameraId, Date.now());

    try {
      const t0 = performance.now();

      /** 调用 VLM API 分析帧 */
      const vlmResult = await this.analyzeWithVlm(jpeg, cameraId, timestamp);

      /** 将 VLM 结果转为 Detection 格式 */
      const detections: Detection[] = vlmResult.objects.map(obj => ({
        label: obj.label,
        score: obj.score,
        box: obj.box ?? { xmin: 0, ymin: 0, xmax: 0, ymax: 0 },
        semanticLabel: obj.description,
      }));

      /** 过滤低置信度 */
      const threshold = this.runtimeConfig.getAiThreshold(cameraId);
      const filtered = detections.filter(d => d.score >= threshold);

      /** 目标追踪：跨帧保持同一 ID */
      let tracker = this.trackers.get(cameraId);
      if (!tracker) {
        tracker = new ObjectTracker();
        this.trackers.set(cameraId, tracker);
      }
      const trackResult = tracker.update(filtered);

      /** 新目标出现时保存裁剪快照到 TrackStorage */
      /** 建立 trackId → semanticLabel 的映射 */
      const trackSemanticMap = new Map<number, string>();
      for (const d of filtered) {
        if (d.semanticLabel && d.trackId != null) {
          trackSemanticMap.set(d.trackId, d.semanticLabel);
        }
      }
      /** tracker.update 后 trackId 分配到 appeared 目标，需要从 detections 的追踪结果中获取 */
      for (const td of trackResult.detections) {
        if (td.semanticLabel && td.trackId != null) {
          trackSemanticMap.set(td.trackId, td.semanticLabel);
          this.semanticLabelCache.set(td.trackId, td.semanticLabel);
        }
      }

      if (this.trackStorage && trackResult.appeared.length > 0) {
        for (const target of trackResult.appeared) {
          const semanticLabel = trackSemanticMap.get(target.trackId);

          this.trackStorage.upsert(
            target.trackId,
            target.label,
            cameraId,
            timestamp,
            jpeg,
            target.box,
            target.score,
          ).then(() => {
            const record = this.trackStorage!.getRecord(target.trackId);

            /** 保存 VLM 语义描述 */
            if (semanticLabel && this.trackStorage) {
              this.trackStorage.setSemanticLabel(target.trackId, semanticLabel);
            }

            /** CLIP 分类（可选，补充更丰富的语义标签） */
            if (this.clipService && target.box) {
              this.clipService.classifyTarget(jpeg, target.box, target.label)
                .then(result => {
                  const top = ClipService.getTopLabels(result, 1);
                  /** CLIP 结果仅在 VLM 没有描述时补充 */
                  if (top.length > 0 && top[0]!.score > 0.25 && !semanticLabel) {
                    this.semanticLabelCache.set(target.trackId, top[0]!.label);
                    if (this.trackStorage) {
                      this.trackStorage.setSemanticLabel(target.trackId, top[0]!.label);
                    }
                    console.log(`[AiDetector] CLIP 补充分类: track#${target.trackId} (${target.label}) → ${top[0]!.label} (${(top[0]!.score * 100).toFixed(0)}%)`);
                  }

                  /** CLIP image embedding 用于 ReID */
                  const clipEmbedding = result.imageEmbedding;
                  if (clipEmbedding?.length && this.trackStorage) {
                    this.trackStorage.setClipEmbedding(target.trackId, clipEmbedding);
                  }

                  /** 外观匹配 */
                  if (!record?.dhash && !clipEmbedding?.length) return;
                  const matches = this.trackStorage!.findSimilar(
                    target.trackId, cameraId, target.label,
                    record?.dhash ?? "", 0.4,
                    record?.colorHist, record?.lbpHist,
                    clipEmbedding?.length ? clipEmbedding : record?.clipEmbedding,
                  );
                  if (matches.length > 0) {
                    this.eventBus.emit("track:match-suggest", {
                      cameraId,
                      timestamp,
                      trackId: target.trackId,
                      label: target.label,
                      matches,
                    });
                    const best = matches[0]!;
                    const autoThreshold = this.runtimeConfig.get().ai.autoMatchThreshold;
                    if (autoThreshold > 0 && best.distance < autoThreshold && this.trackLabelStorage) {
                      this.trackLabelStorage.upsert(cameraId, target.trackId, target.label, best.customName);
                      this.trackStorage!.setCustomName(target.trackId, best.customName);
                      this.trackNameCache.delete(`${cameraId}:${target.trackId}`);
                      this.eventBus.emit("track:label-updated", {
                        cameraId,
                        trackId: target.trackId,
                        name: best.customName,
                      });
                      console.log(`[AiDetector] 自动关联: track#${target.trackId} → ${best.customName} (${(best.distance * 100).toFixed(0)}%)`);
                    }
                  }
                })
                .catch(() => { /* CLIP 推理失败不影响主流程 */ });
            }
          }).catch(err => console.error(`[AiDetector] 追踪快照保存失败:`, err));
        }
      }

      /** 更新已有活跃目标的 lastSeen/hitCount */
      if (this.trackStorage && trackResult.detections.length > 0) {
        const appearedIds = new Set(trackResult.appeared.map(a => a.trackId));
        const existing = trackResult.detections
          .filter(d => d.trackId != null && !appearedIds.has(d.trackId));
        if (existing.length > 0) {
          this.trackStorage.touchSeen(existing.map(d => ({ trackId: d.trackId!, cameraId })), timestamp);
        }
      }

      const totalMs = performance.now() - t0;

      /** 智能降频：无目标时增加空检测计数，有目标时重置 */
      if (trackResult.detections.length === 0) {
        this.emptyDetectStreak.set(cameraId, (this.emptyDetectStreak.get(cameraId) ?? 0) + 1);
      } else {
        this.emptyDetectStreak.set(cameraId, 0);
      }

      /** 去重 */
      const fp = JSON.stringify(vlmResult.objects.map(o => `${o.label}:${o.score?.toFixed(2)}`));
      const prevFp = this.lastDetectFingerprint.get(cameraId);
      const changed = fp !== prevFp;
      this.lastDetectFingerprint.set(cameraId, fp);

      /** 发射追踪目标出现/消失事件 */
      for (const target of trackResult.appeared) {
        const trackName = this.lookupTrackName(cameraId, target.trackId);
        this.eventBus.emit("track:appeared", {
          cameraId,
          timestamp,
          trackId: target.trackId,
          label: target.label,
          score: target.score,
          trackName: trackName || undefined,
          semanticLabel: target.trackId ? this.semanticLabelCache.get(target.trackId) : undefined,
        });
      }
      for (const target of trackResult.disappeared) {
        const trackName = this.lookupTrackName(cameraId, target.trackId);
        this.eventBus.emit("track:disappeared", {
          cameraId,
          timestamp,
          trackId: target.trackId,
          label: target.label,
          trackName: trackName || undefined,
          semanticLabel: target.trackId ? this.semanticLabelCache.get(target.trackId) : undefined,
        });
      }

      /** 写入轨迹采样点 */
      if (this.trajectoryStorage && trackResult.detections.length > 0) {
        const trajItems = trackResult.detections
          .filter(d => d.trackId != null && d.box)
          .map(d => ({
            trackId: d.trackId!,
            cx: (d.box.xmin + d.box.xmax) / 2,
            cy: (d.box.ymin + d.box.ymax) / 2,
            w: d.box.xmax - d.box.xmin,
            h: d.box.ymax - d.box.ymin,
          }));
        if (trajItems.length > 0) {
          this.trajectoryStorage.insertBatch(cameraId, timestamp, trajItems);
        }
      }

      /** 为检测结果附带用户自定义名称、主色调和语义标签 */
      const enricheddetections = trackResult.detections.map(d => {
        const trackName = d.trackId ? this.lookupTrackName(cameraId, d.trackId) : undefined;
        const dominantColor = d.trackId ? this.lookupDominantColor(d.trackId) : undefined;
        const semanticLabel = d.trackId ? this.semanticLabelCache.get(d.trackId) : undefined;
        return { ...d, trackName: trackName || undefined, dominantColor, semanticLabel };
      });

      /** 缓存最新帧和 enriched 检测结果 */
      this.annotator.setLatestFrame(cameraId, jpeg, enricheddetections);

      /** 目标间接近检测 */
      this.detectApproaches(cameraId, timestamp, enricheddetections);

      /** 发射场景描述事件（复用 llm:scene） */
      if (vlmResult.scene) {
        this.eventBus.emit("llm:scene", {
          cameraId,
          timestamp,
          description: vlmResult.scene,
          trigger: "detect",
          inferMs: vlmResult.inferMs,
        });
      }

      this.eventBus.emit("detect", {
        cameraId,
        timestamp,
        detections: enricheddetections,
        frameImage: jpeg,
        changed,
        inferMs: vlmResult.inferMs,
      });

      if (trackResult.detections.length > 0 || vlmResult.inferMs > 1000) {
        const trackIds = trackResult.detections.map(d => `${d.label}#${d.trackId}`).join(", ");
        console.log(`[Perf][AI][${cameraId}] ${trackResult.detections.length} 目标 (${trackIds || "-"}), infer=${vlmResult.inferMs.toFixed(0)}ms, total=${totalMs.toFixed(0)}ms`);
      }
    } catch (err) {
      console.error(`[AiDetector] VLM 检测失败:`, err);
    } finally {
      this.analyzing.delete(cameraId);
    }
  }

  /** 检测目标间的接近事件 */
  private detectApproaches(
    cameraId: string,
    timestamp: number,
    detections: Array<{ trackId?: number; label: string; box?: { xmin: number; ymin: number; xmax: number; ymax: number }; trackName?: string; semanticLabel?: string }>,
  ): void {
    const targets = detections.filter(d => d.trackId != null && d.box);
    if (targets.length < 2) return;

    const now = Date.now();
    const threshold = AiDetector.APPROACH_DISTANCE_THRESHOLD;

    for (let i = 0; i < targets.length; i++) {
      const a = targets[i]!;
      const aCx = (a.box!.xmin + a.box!.xmax) / 2;
      const aCy = (a.box!.ymin + a.box!.ymax) / 2;

      for (let j = i + 1; j < targets.length; j++) {
        const b = targets[j]!;
        const bCx = (b.box!.xmin + b.box!.xmax) / 2;
        const bCy = (b.box!.ymin + b.box!.ymax) / 2;

        const dist = Math.sqrt((aCx - bCx) ** 2 + (aCy - bCy) ** 2);
        if (dist >= threshold) continue;

        const pairKey = a.trackId! < b.trackId!
          ? `${a.trackId}:${b.trackId}`
          : `${b.trackId}:${a.trackId}`;
        const lastTime = this.approachCooldown.get(pairKey);
        if (lastTime && now - lastTime < AiDetector.APPROACH_COOLDOWN_MS) continue;

        this.approachCooldown.set(pairKey, now);

        const aTrackName = a.trackName || this.lookupTrackName(cameraId, a.trackId!);
        const bTrackName = b.trackName || this.lookupTrackName(cameraId, b.trackId!);

        this.eventBus.emit("track:approach", {
          cameraId,
          timestamp,
          trackId: a.trackId!,
          label: a.label,
          trackName: aTrackName || undefined,
          semanticLabel: a.semanticLabel || this.semanticLabelCache.get(a.trackId!),
          targetTrackId: b.trackId!,
          targetLabel: b.label,
          targetTrackName: bTrackName || undefined,
          targetSemanticLabel: b.semanticLabel || this.semanticLabelCache.get(b.trackId!),
          distance: dist,
        });
      }
    }

    for (const [key, time] of this.approachCooldown) {
      if (now - time > 60_000) this.approachCooldown.delete(key);
    }
  }

  /** 销毁检测器 */
  dispose(): void {
    this.stopContinuousLoop();
    if (this.trackNameCacheTimer) {
      clearInterval(this.trackNameCacheTimer);
      this.trackNameCacheTimer = null;
    }
    this.initialized = false;
  }

  /** 查找 trackName（带内存缓存，30 秒刷新） */
  private lookupTrackName(cameraId: string, trackId: number): string | undefined {
    if (!this.trackLabelStorage) return undefined;
    const key = `${cameraId}:${trackId}`;
    const cached = this.trackNameCache.get(key);
    if (cached !== undefined) return cached || undefined;
    const name = this.trackLabelStorage.findByTrack(cameraId, trackId)?.name ?? "";
    this.trackNameCache.set(key, name);
    return name || undefined;
  }

  /** 查找 dominantColor（带内存缓存，30 秒刷新） */
  private lookupDominantColor(trackId: number): string | undefined {
    if (!this.trackStorage) return undefined;
    const cached = this.trackColorCache.get(trackId);
    if (cached !== undefined) return cached || undefined;
    const record = this.trackStorage.getRecord(trackId);
    const color = record?.colorHist ? TrackStorage.extractDominantColor(record.colorHist) : "";
    this.trackColorCache.set(trackId, color);
    return color || undefined;
  }

  /** 命名后反向关联 */
  propagateName(trackId: number, name: string, sourceCameraId: string): void {
    if (!this.trackStorage || !this.trackLabelStorage) return;
    const record = this.trackStorage.getRecord(trackId);
    if (!record?.clipEmbedding?.length && !record?.dhash) return;

    const autoThreshold = this.runtimeConfig.get().ai.autoMatchThreshold;
    if (autoThreshold <= 0) return;

    const matches = this.trackStorage.findSimilar(
      trackId, sourceCameraId, record.label, record.dhash ?? "", 0.4,
      record.colorHist, record.lbpHist, record.clipEmbedding,
    );

    for (const match of matches) {
      if (match.distance >= autoThreshold) continue;
      const matchRec = this.trackStorage.getRecord(match.trackId);
      if (matchRec?.customName) continue;
      for (const camId of matchRec?.cameraIds ?? []) {
        this.trackLabelStorage.upsert(camId, match.trackId, matchRec?.label ?? record.label, name);
      }
      this.trackStorage.setCustomName(match.trackId, name);
      for (const camId of matchRec?.cameraIds ?? []) {
        this.trackNameCache.delete(`${camId}:${match.trackId}`);
      }
      const camId = matchRec?.cameraIds[0] ?? sourceCameraId;
      this.eventBus.emit("track:label-updated", { cameraId: camId, trackId: match.trackId, name });
      console.log(`[AiDetector] 命名传播: track#${match.trackId} → ${name} (${(match.distance * 100).toFixed(0)}%)`);
    }
  }
}
