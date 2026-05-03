import { type EventBus } from "@/event-bus";
import { type RuntimeConfig } from "@/runtime-config";

/** 单个行为事件记录 */
interface ActivityEvent {
  /** 事件类型 */
  type: string;
  /** 时间戳 */
  timestamp: number;
  /** 事件摘要 */
  summary: string;
}

/** 目标活动档案 */
export interface TrackActivityProfile {
  /** 摄像头 ID */
  cameraId: string;
  /** 追踪 ID */
  trackId: number;
  /** 目标标签 */
  label: string;
  /** 用户名称 */
  trackName?: string;
  /** CLIP 语义标签 */
  semanticLabel?: string;
  /** 首次出现时间 */
  firstSeen: number;
  /** 最后出现时间 */
  lastSeen: number;
  /** 访问过的区域列表 */
  zones: Array<{ zoneId: number; zoneName: string; totalDwellMs: number; enterCount: number }>;
  /** 触发的行为事件列表 */
  events: ActivityEvent[];
  /** 移动距离（归一化坐标累计） */
  totalDistance: number;
  /** AI 生成的行为摘要（消失时生成） */
  aiSummary?: string;
}

/** AI 目标活动摘要结果 */
export interface TrackActivitySummary {
  /** 摄像头 ID */
  cameraId: string;
  /** 追踪 ID */
  trackId: number;
  /** 目标标签 */
  label: string;
  /** 用户名称 */
  trackName?: string;
  /** AI 行为摘要 */
  summary: string;
  /** 总存活时间 ms */
  lifespanMs: number;
  /** 区域访问数 */
  zoneCount: number;
  /** 事件数 */
  eventCount: number;
  [key: string]: unknown;
}

/**
 * 目标活动档案收集器
 * 监听各种追踪事件，为每个 trackId 维护活动档案
 * 目标消失时生成 AI 行为摘要并推送
 */
export class TrackActivityCollector {
  private eventBus: EventBus;
  private runtimeConfig: RuntimeConfig;
  /** 活跃目标档案：cameraId:trackId -> profile */
  private profiles = new Map<string, TrackActivityProfile>();
  /** 事件最大记录数 */
  private static readonly MAX_EVENTS = 50;
  /** 最大并存档案数 */
  private static readonly MAX_PROFILES = 200;
  /** 取消订阅函数 */
  private unsubs: (() => void)[] = [];

  constructor(eventBus: EventBus, runtimeConfig: RuntimeConfig) {
    this.eventBus = eventBus;
    this.runtimeConfig = runtimeConfig;
  }

  start(): void {
    const events = [
      "track:appeared",
      "track:disappeared",
      "track:enter-zone",
      "track:leave-zone",
      "track:dwell",
      "track:speed",
      "track:line-cross",
      "track:loiter",
      "track:approach",
    ] as const;

    for (const event of events) {
      const unsub = this.eventBus.on(event, (payload) => {
        this.handleEvent(event, payload);
      });
      this.unsubs.push(unsub);
    }
  }

  stop(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.profiles.clear();
  }

  /** 获取指定目标的活动档案 */
  getProfile(cameraId: string, trackId: number): TrackActivityProfile | undefined {
    return this.profiles.get(`${cameraId}:${trackId}`);
  }

  /** 处理事件 */
  private handleEvent(event: string, payload: Record<string, unknown>): void {
    const cameraId = payload.cameraId as string;
    const trackId = payload.trackId as number;
    if (!cameraId || trackId == null) return;

    const key = `${cameraId}:${trackId}`;

    if (event === "track:appeared") {
      this.ensureProfile(key, cameraId, trackId, payload);
      const profile = this.profiles.get(key)!;
      profile.firstSeen = (payload.timestamp as number) ?? Date.now();
      profile.lastSeen = profile.firstSeen;
      return;
    }

    if (event === "track:disappeared") {
      const profile = this.profiles.get(key);
      if (profile) {
        profile.lastSeen = (payload.timestamp as number) ?? Date.now();
        profile.trackName = payload.trackName as string | undefined;
        profile.semanticLabel = payload.semanticLabel as string | undefined;
        this.generateSummary(profile);
        this.profiles.delete(key);
      }
      return;
    }

    /** 更新档案 */
    const profile = this.profiles.get(key);
    if (!profile) return;

    profile.lastSeen = (payload.timestamp as number) ?? Date.now();
    profile.trackName = payload.trackName as string | undefined;
    profile.semanticLabel = payload.semanticLabel as string | undefined;

    const timestamp = payload.timestamp as number;

    switch (event) {
      case "track:enter-zone": {
        const zoneId = payload.zoneId as number;
        const zoneName = payload.zoneName as string;
        let zone = profile.zones.find(z => z.zoneId === zoneId);
        if (!zone) {
          zone = { zoneId, zoneName, totalDwellMs: 0, enterCount: 0 };
          profile.zones.push(zone);
        }
        zone.enterCount++;
        this.addEvent(profile, event, timestamp, `进入 ${zoneName}`);
        break;
      }
      case "track:leave-zone": {
        const zoneId = payload.zoneId as number;
        const dwellMs = payload.dwellMs as number;
        const zoneName = payload.zoneName as string;
        const zone = profile.zones.find(z => z.zoneId === zoneId);
        if (zone) zone.totalDwellMs += dwellMs;
        this.addEvent(profile, event, timestamp, `离开 ${zoneName} (停留 ${(dwellMs / 1000).toFixed(0)}s)`);
        break;
      }
      case "track:dwell": {
        const zoneName = payload.zoneName as string;
        const dwellMs = payload.dwellMs as number;
        this.addEvent(profile, event, timestamp, `在 ${zoneName} 停留 ${(dwellMs / 1000).toFixed(0)}s`);
        break;
      }
      case "track:speed": {
        const speed = payload.speed as number;
        this.addEvent(profile, event, timestamp, `高速移动 (${speed.toFixed(3)}/帧)`);
        break;
      }
      case "track:line-cross": {
        const lineName = payload.lineName as string;
        const direction = payload.direction as string;
        this.addEvent(profile, event, timestamp, `穿越 ${lineName} ${direction}`);
        break;
      }
      case "track:loiter": {
        const durationMs = payload.durationMs as number;
        this.addEvent(profile, event, timestamp, `徘徊 ${(durationMs / 1000).toFixed(0)}s`);
        break;
      }
      case "track:approach": {
        const targetLabel = payload.targetLabel as string;
        const distance = payload.distance as number;
        this.addEvent(profile, event, timestamp, `接近 ${targetLabel} (距离 ${distance.toFixed(2)})`);
        break;
      }
    }
  }

  /** 确保档案存在 */
  private ensureProfile(key: string, cameraId: string, trackId: number, payload: Record<string, unknown>): void {
    if (this.profiles.has(key)) return;
    if (this.profiles.size >= TrackActivityCollector.MAX_PROFILES) {
      /** 淘汰最旧的 */
      let oldestKey = "";
      let oldestTime = Infinity;
      for (const [k, p] of this.profiles) {
        if (p.firstSeen < oldestTime) { oldestTime = p.firstSeen; oldestKey = k; }
      }
      if (oldestKey) this.profiles.delete(oldestKey);
    }
    this.profiles.set(key, {
      cameraId,
      trackId,
      label: (payload.label as string) ?? "unknown",
      trackName: payload.trackName as string | undefined,
      semanticLabel: payload.semanticLabel as string | undefined,
      firstSeen: Date.now(),
      lastSeen: Date.now(),
      zones: [],
      events: [],
      totalDistance: 0,
    });
  }

  /** 添加事件记录 */
  private addEvent(profile: TrackActivityProfile, type: string, timestamp: number, summary: string): void {
    if (profile.events.length >= TrackActivityCollector.MAX_EVENTS) {
      profile.events.shift();
    }
    profile.events.push({ type, timestamp, summary });
  }

  /** 生成 AI 行为摘要（目标消失时） */
  private async generateSummary(profile: TrackActivityProfile): Promise<void> {
    const llmConfig = this.runtimeConfig.get().ai.llm;
    if (!llmConfig.enabled || !llmConfig.apiUrl || !llmConfig.model) return;

    /** 事件太少不值得摘要 */
    if (profile.events.length < 2) return;

    const lifespanSec = Math.round((profile.lastSeen - profile.firstSeen) / 1000);
    const name = profile.trackName || `#${profile.trackId}`;
    const label = profile.semanticLabel || profile.label;

    const zoneSummary = profile.zones.length > 0
      ? profile.zones.map(z => `${z.zoneName}(${(z.totalDwellMs / 1000).toFixed(0)}s)`).join(", ")
      : "无";

    const eventLines = profile.events.slice(-15).map(e => {
      const time = new Date(e.timestamp).toLocaleTimeString();
      return `[${time}] ${e.summary}`;
    }).join("\n");

    const lang = this.runtimeConfig.get().language;
    const langInstruction = lang.startsWith("zh") ? "Write in Chinese." : "Write in English.";

    const systemPrompt = `Summarize this tracked object's activity. Max 2 sentences. Be factual. ${langInstruction}`;

    const body = {
      model: llmConfig.model,
      messages: [
        { role: "system" as const, content: systemPrompt },
        {
          role: "user" as const,
          content: `Object: ${name} (${label})\nDuration: ${lifespanSec}s\nZones: ${zoneSummary}\nEvents:\n${eventLines}`,
        },
      ],
      max_tokens: 100,
      temperature: 0.2,
    };

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8_000);
      const response = await fetch(
        llmConfig.apiUrl.endsWith("/chat/completions") ? llmConfig.apiUrl : `${llmConfig.apiUrl.replace(/\/$/, "")}/v1/chat/completions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      ).finally(() => clearTimeout(timeout));

      if (!response.ok) return;

      const result = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const summaryText = result.choices?.[0]?.message?.content?.trim();
      if (!summaryText) return;

      const summary: TrackActivitySummary = {
        cameraId: profile.cameraId,
        trackId: profile.trackId,
        label: profile.label,
        trackName: profile.trackName,
        summary: summaryText,
        lifespanMs: profile.lastSeen - profile.firstSeen,
        zoneCount: profile.zones.length,
        eventCount: profile.events.length,
      };

      this.eventBus.emit("track:activity-summary" as keyof import("@/event-bus").EventPayloads, summary as never);
    } catch {
      /** 静默失败，不影响主流程 */
    }
  }
}
