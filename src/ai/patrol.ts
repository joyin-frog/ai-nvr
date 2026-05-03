import { type EventBus } from "@/event-bus";
import { type RuntimeConfig } from "@/runtime-config";
import { type EventStorage } from "@/storage/events";
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
{"status":"normal","observations":"what you see","anomaly":""}
status: "normal", "unusual", or "alert". anomaly: describe the concern, or "" if normal.`;

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
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  /** 是否正在巡逻中 */
  private patrolling = false;
  /** 全局并发限制 */
  private concurrent = 0;
  private static readonly MAX_CONCURRENT = 2;

  /** 巡逻间隔（毫秒） */
  private static readonly PATROL_INTERVAL = 120_000;

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
    const llmConfig = this.runtimeConfig.get().ai.llm;
    if (!llmConfig.enabled || !llmConfig.apiUrl || !llmConfig.model) return;

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
    const llmConfig = this.runtimeConfig.get().ai.llm;
    if (!llmConfig.enabled || !llmConfig.apiUrl || !llmConfig.model) {
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

    const llmConfig = this.runtimeConfig.get().ai.llm;
    const lang = this.runtimeConfig.get().language;
    const langInstruction = lang.startsWith("zh") ? "\nIMPORTANT: Write ALL text in Chinese (中文)." : "";
    const systemPrompt = PATROL_SYSTEM_PROMPT + langInstruction;

    /** 依次扫描每个摄像头（受并发限制） */
    for (const cam of cameras) {
      if (!this.started) break;

      const frameInfo = this.frameProvider.getLatestFrameWithTimestamp(cam.id);
      if (!frameInfo) continue;

      /** 跳过超过 30 秒的旧帧 */
      if (Date.now() - frameInfo.timestamp > 30_000) continue;

      await this.acquireSlot();
      this.analyzeCamera(cam, frameInfo.data, frameInfo.timestamp, systemPrompt, llmConfig)
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
    systemPrompt: string,
    llmConfig: { apiUrl: string; model: string; imageWidth: number; maxTokens: number },
  ): Promise<void> {
    const t0 = performance.now();

    /** 缩放图片 */
    let imageDataUrl: string;
    if (llmConfig.imageWidth > 0) {
      const resized = await sharp(jpeg, { failOn: "none" })
        .resize(llmConfig.imageWidth)
        .jpeg({ quality: 75 })
        .toBuffer();
      imageDataUrl = `data:image/jpeg;base64,${resized.toString("base64")}`;
    } else {
      imageDataUrl = `data:image/jpeg;base64,${jpeg.toString("base64")}`;
    }

    const body = {
      model: llmConfig.model,
      messages: [
        { role: "system" as const, content: systemPrompt },
        {
          role: "user" as const,
          content: [
            { type: "text" as const, text: `Camera: ${cam.name}. Analyze the current scene.` },
            { type: "image_url" as const, image_url: { url: imageDataUrl } },
          ],
        },
      ],
      max_tokens: 150,
      temperature: 0.2,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    const response = await fetch(llmConfig.apiUrl, {
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

    /** 解析结果 */
    const parsed = this.parsePatrolResult(content);
    const patrolResult: PatrolResult = {
      cameraId: cam.id,
      cameraName: cam.name,
      timestamp,
      analysis: parsed.observations,
      hasAnomaly: parsed.status !== "normal",
      anomalyDetail: parsed.anomaly,
      inferMs,
    };

    /** 异常时写入事件存储（使巡逻报告可在事件面板中回溯查询） */
    if (patrolResult.hasAnomaly && this.eventStorage) {
      const detailJson = JSON.stringify(patrolResult);
      this.eventStorage.insert("llm:patrol", cam.id, timestamp, detailJson);
    }

    this.eventBus.emit("llm:patrol" as keyof import("@/event-bus").EventPayloads, patrolResult as never);

    /** 异常时额外记录日志 */
    if (patrolResult.hasAnomaly) {
      console.log(`[AiPatrol] ${cam.name}: ${parsed.status.toUpperCase()} — ${parsed.anomaly || parsed.observations}`);
    }
  }

  /** 解析巡逻结果 */
  private parsePatrolResult(content: string): { status: string; observations: string; anomaly: string } {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const obj = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
        return {
          status: typeof obj.status === "string" ? obj.status : "normal",
          observations: typeof obj.observations === "string" ? obj.observations : content,
          anomaly: typeof obj.anomaly === "string" ? obj.anomaly : "",
        };
      } catch { /* fallback */ }
    }
    return { status: "normal", observations: content, anomaly: "" };
  }
}
