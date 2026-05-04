import { type EventBus } from "@/event-bus";
import { type RuntimeConfig } from "@/runtime-config";
import { aiMetrics } from "./metrics";
import { type EventStorage } from "@/storage/events";
import { resolveModel } from "./multimodal-analyzer";
import sharp from "sharp";

/** 摄像头信息接口 */
interface CameraInfo {
  /** 摄像头 ID */
  id: string;
  /** 友好名称 */
  name: string;
  /** 是否在线 */
  online: boolean;
}

/** 帧提供者接口（CameraManager 实现此接口） */
export interface PatrolFrameProvider {
  getLatestFrameWithTimestamp(cameraId: string): { data: Buffer; timestamp: number } | undefined;
  getStatus(): Array<{ id: string; name: string; online: boolean; [k: string]: unknown }>;
}

/** AI 巡逻结果 */
export interface PatrolResult {
  /** 摄像头 ID */
  cameraId: string;
  /** 摄像头名称 */
  cameraName: string;
  /** 巡逻时间 */
  timestamp: number;
  /** AI 巡逻分析 */
  analysis: string;
  /** 是否发现异常 */
  hasAnomaly: boolean;
  /** 异常描述（无异常时为空） */
  anomalyDetail: string;
  /** 推理耗时 ms */
  inferMs: number;
  [key: string]: unknown;
}

/** 巡逻 system prompt：精简版，适配 0.8B 小模型 */
const PATROL_SYSTEM_PROMPT = `Analyze this surveillance image. Output JSON only:
{"status":"normal","observations":"what you see","count":{"person":0,"vehicle":0},"anomaly":""}
status: "normal", "unusual", or "alert".
count: number of people and vehicles visible.
anomaly: describe the concern, or "" if normal.`;

/** 多帧巡逻 prompt：增加运动轨迹和时序变化分析 */
const PATROL_MULTI_FRAME_PROMPT = `Multiple frames from same camera. First=latest, rest=older context.
Analyze movement, direction, and changes over time.
Output JSON only:
{"status":"normal","observations":"scene description with movement","count":{"person":0,"vehicle":0},"movement":"who moved where","anomaly":""}
status: "normal", "unusual", or "alert".
count: number in latest frame.
movement: brief description of movement (e.g. "person walked left to right").
anomaly: describe the concern, or "" if normal.`;

/**
 * AI 主动巡逻扫描器
 * 定期扫描所有在线摄像头，生成全局态势感知报告
 * 与事件驱动的 MultimodalAnalyzer 互补：巡逻是主动的全局扫描，不是被动响应
 */
export class AiPatrolScanner {
  private eventBus: EventBus;
  private runtimeConfig: RuntimeConfig;
  private frameProvider: PatrolFrameProvider;
  private eventStorage?: EventStorage;
  /** Recorder 引用（用于获取上下文帧） */
  private recorder: { getContextFrames(cameraId: string, now: number, intervalMs: number, maxFrames?: number): Array<{ data: Buffer; timestamp: number }> } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  /** 是否正在巡逻中 */
  private patrolling = false;
  /** 全局并发限制 */
  private concurrent = 0;
  private static readonly MAX_CONCURRENT = 2;

  /** 巡逻间隔（毫秒） */
  private static readonly PATROL_INTERVAL = 120_000;

  setRecorder(rec: { getContextFrames(cameraId: string, now: number, intervalMs: number, maxFrames?: number): Array<{ data: Buffer; timestamp: number }> }): void {
    this.recorder = rec;
  }

  constructor(
    eventBus: EventBus,
    runtimeConfig: RuntimeConfig,
    frameProvider: PatrolFrameProvider,
    eventStorage?: EventStorage,
  ) {
    this.eventBus = eventBus;
    this.runtimeConfig = runtimeConfig;
    this.frameProvider = frameProvider;
    this.eventStorage = eventStorage;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const aiCfg = this.runtimeConfig.get().ai;
    const llmConfig = aiCfg.llm;
    const resolved = resolveModel(aiCfg.models, aiCfg.llm);
    if (!llmConfig.enabled || !resolved.apiUrl || !resolved.model) return;

    this.timer = setInterval(() => this.patrol(), AiPatrolScanner.PATROL_INTERVAL);
    console.log(`[AiPatrol] AI 主动巡逻已启动 (间隔 ${AiPatrolScanner.PATROL_INTERVAL / 1000}s)`);
  }

  stop(): void {
    this.started = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.patrolling = false;
    this.concurrent = 0;
  }

  /** 手动触发一轮巡逻（前端按钮触发） */
  async triggerNow(): Promise<{ triggered: boolean; message: string }> {
    const aiCfg = this.runtimeConfig.get().ai;
    const llmConfig = aiCfg.llm;
    const resolved = resolveModel(aiCfg.models, aiCfg.llm);
    if (!llmConfig.enabled || !resolved.apiUrl || !resolved.model) {
      return { triggered: false, message: "LLM not enabled" };
    }
    if (this.patrolling) {
      return { triggered: false, message: "Patrol already in progress" };
    }
    this.patrol().catch(() => {});
    return { triggered: true, message: "Patrol started" };
  }

  /** 执行一轮巡逻 */
  private async patrol(): Promise<void> {
    if (this.patrolling) return;
    this.patrolling = true;

    const cameras = this.frameProvider.getStatus().filter(c => c.online);
    if (cameras.length === 0) {
      this.patrolling = false;
      return;
    }

    const aiCfg = this.runtimeConfig.get().ai;
    const llmConfig = aiCfg.llm;
    const resolved = resolveModel(aiCfg.models, aiCfg.llm);

    /** 依次扫描每个摄像头（受并发限制） */
    for (const cam of cameras) {
      if (!this.started) break;

      const frameInfo = this.frameProvider.getLatestFrameWithTimestamp(cam.id);
      if (!frameInfo) continue;

      /** 跳过超过 30 秒的旧帧 */
      if (Date.now() - frameInfo.timestamp > 30_000) continue;

      await this.acquireSlot();
      this.analyzeCamera(cam, frameInfo.data, frameInfo.timestamp, { ...resolved, imageWidth: llmConfig.imageWidth, contextIntervalMs: llmConfig.contextIntervalMs })
        .catch(err => {
          console.warn(`[AiPatrol] ${cam.name} 分析失败:`, err instanceof Error ? err.message : String(err));
        })
        .finally(() => this.releaseSlot());
    }

    this.patrolling = false;
  }

  private acquireSlot(): Promise<void> {
    if (this.concurrent < AiPatrolScanner.MAX_CONCURRENT) {
      this.concurrent++;
      return Promise.resolve();
    }
    return new Promise<void>(resolve => {
      const check = () => {
        if (this.concurrent < AiPatrolScanner.MAX_CONCURRENT) {
          this.concurrent++;
          resolve();
        } else {
          setTimeout(check, 500);
        }
      };
      setTimeout(check, 500);
    });
  }

  private releaseSlot(): void {
    this.concurrent--;
  }

  /** 分析单个摄像头 */
  private async analyzeCamera(
    cam: CameraInfo,
    jpeg: Buffer,
    timestamp: number,
    llmConfig: { apiUrl: string; model: string; imageWidth: number; maxTokens: number; contextIntervalMs?: number },
  ): Promise<void> {
    const t0 = performance.now();

    /** 缩放图片辅助函数 */
    const resizeImage = async (img: Buffer): Promise<string> => {
      if (llmConfig.imageWidth > 0) {
        const resized = await sharp(img, { failOn: "none" })
          .resize(llmConfig.imageWidth)
          .jpeg({ quality: 75 })
          .toBuffer();
        return `data:image/jpeg;base64,${resized.toString("base64")}`;
      }
      return `data:image/jpeg;base64,${img.toString("base64")}`;
    };

    /** 获取上下文帧 */
    const contextIntervalMs = llmConfig.contextIntervalMs ?? 0;
    let contextFrames: Array<{ data: Buffer; timestamp: number }> = [];
    if (this.recorder && contextIntervalMs > 0) {
      contextFrames = this.recorder.getContextFrames(cam.id, timestamp, contextIntervalMs);
    }
    const hasContext = contextFrames.length > 0;
    const prompt = hasContext ? PATROL_MULTI_FRAME_PROMPT : PATROL_SYSTEM_PROMPT;
    const lang = this.runtimeConfig.get().language;
    const langInstruction = lang.startsWith("zh") ? "\nIMPORTANT: Write ALL text in Chinese (中文)." : "";
    const finalPrompt = prompt + langInstruction;

    const imageDataUrl = await resizeImage(jpeg);

    /** 构建 user content */
    const userContent: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
      { type: "text", text: `Camera: ${cam.name}.${hasContext ? " Latest frame:" : " Analyze the scene."}` },
      { type: "image_url", image_url: { url: imageDataUrl } },
    ];

    if (hasContext) {
      const ctxUrls = await Promise.all(contextFrames.map(f => resizeImage(f.data)));
      for (let i = 0; i < contextFrames.length; i++) {
        const agoSec = Math.round((timestamp - contextFrames[i]!.timestamp) / 1000);
        userContent.push({ type: "text", text: `${agoSec}s ago:` });
        userContent.push({ type: "image_url", image_url: { url: ctxUrls[i]! } });
      }
    }

    const body = {
      model: llmConfig.model,
      messages: [
        { role: "system" as const, content: finalPrompt },
        { role: "user" as const, content: userContent },
      ],
      max_tokens: 150,
      temperature: 0.2,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    const apiUrl = llmConfig.apiUrl.endsWith("/chat/completions")
      ? llmConfig.apiUrl
      : `${llmConfig.apiUrl.replace(/\/$/, "")}/v1/chat/completions`;

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    if (!response.ok) return;

    const result = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = result.choices?.[0]?.message?.content?.trim();
    if (!content) return;

    const inferMs = performance.now() - t0;

    aiMetrics.record({ source: "patrol", inferMs, ok: true });

    /** 解析结果 */
    const parsed = this.parsePatrolResult(content);
    const patrolResult: PatrolResult = {
      cameraId: cam.id,
      cameraName: cam.name,
      timestamp,
      analysis: parsed.observations,
      hasAnomaly: parsed.status !== "normal",
      anomalyDetail: parsed.anomaly,
      movement: parsed.movement,
      count: parsed.count,
      inferMs,
    };

    /** 始终写入事件存储（用于趋势分析），异常时 detail 包含更多信息 */
    if (this.eventStorage) {
      const detailJson = JSON.stringify(patrolResult);
      this.eventStorage.insert("llm:patrol", cam.id, timestamp, detailJson);
    }

    /** 人群趋势检测：比较最近几次巡逻的人数变化 */
    if (parsed.count?.person && this.eventStorage) {
      const recentPatrols = this.eventStorage.query({ type: "llm:patrol", cameraId: cam.id, since: timestamp - 600_000, limit: 5 });
      if (recentPatrols.length >= 3) {
        const personCounts: number[] = [parsed.count.person];
        for (const ev of recentPatrols) {
          const detail = JSON.parse(ev.detail || "{}") as { count?: { person?: number } };
          if (detail.count?.person != null) personCounts.push(detail.count.person);
        }
        /** 连续 3 次人数递增 → 人群聚集趋势 */
        if (personCounts.length >= 3 && personCounts[0]! > personCounts[1]! && personCounts[1]! > personCounts[2]!) {
          this.eventBus.emit("track:crowd" as keyof import("@/event-bus").EventPayloads, {
            cameraId: cam.id,
            timestamp,
            count: parsed.count.person,
            trend: "increasing",
            message: `${cam.name}: 人数持续增长至 ${parsed.count.person} 人`,
          } as never);
        }
      }
    }

    this.eventBus.emit("llm:patrol" as keyof import("@/event-bus").EventPayloads, patrolResult as never);

    /** 异常时额外记录日志 */
    if (patrolResult.hasAnomaly) {
      console.log(`[AiPatrol] ${cam.name}: ${parsed.status.toUpperCase()} — ${parsed.anomaly || parsed.observations}`);
    }
  }

  /** 解析巡逻结果 */
  private parsePatrolResult(content: string): { status: string; observations: string; anomaly: string; movement?: string; count?: Record<string, number> } {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const obj = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
        return {
          status: typeof obj.status === "string" ? obj.status : "normal",
          observations: typeof obj.observations === "string" ? obj.observations : content,
          anomaly: typeof obj.anomaly === "string" ? obj.anomaly : "",
          movement: typeof obj.movement === "string" ? obj.movement : undefined,
          count: typeof obj.count === "object" && obj.count !== null ? obj.count as Record<string, number> : undefined,
        };
      } catch { /* fallback */ }
    }
    return { status: "normal", observations: content, anomaly: "" };
  }
}
