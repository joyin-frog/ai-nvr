import { type AppConfig, type MotionConfig, saveRuntimeToYaml, getConfigPath } from "@/config";
import { type AiConfig } from "@/ai/types";
import yaml from "js-yaml";
import { readFileSync } from "node:fs";

/** 每个摄像头的灵敏度覆盖 */
export interface CameraOverride {
  /** 变动检测阈值覆盖 */
  motionThreshold?: number;
  /** 变动检测冷却时间覆盖（ms） */
  motionCooldown?: number;
  /** 检测帧率覆盖 */
  detectFps?: number;
  /** AI 推理分辨率覆盖（0=使用全局配置） */
  inputWidth?: number;
}

/** Webhook 通知配置 */
export interface WebhookConfig {
  /** Webhook 推送 URL 列表 */
  urls: string[];
}

/** 钉钉机器人通知配置 */
export interface DingTalkConfig {
  /** 是否启用 */
  enabled: boolean;
  /** 钉钉自定义机器人 Webhook URL */
  webhookUrl: string;
  /** 加签密钥（可选，不填则不加签） */
  secret: string;
}

/** SMTP 邮件配置 */
export interface EmailSmtpConfig {
  /** SMTP 服务器地址 */
  host: string;
  /** SMTP 端口 */
  port: number;
  /** 是否使用 SSL（465 端口通常为 true） */
  secure: boolean;
  /** SMTP 用户名 */
  user: string;
  /** SMTP 密码 */
  pass: string;
}

/** 邮件通知配置 */
export interface EmailConfig {
  /** 是否启用 */
  enabled: boolean;
  /** SMTP 服务器配置 */
  smtp: EmailSmtpConfig | null;
  /** 发件人地址（可选，默认用 SMTP 用户名） */
  from: string;
  /** 收件人地址（多个用逗号分隔） */
  to: string;
}

/** 通知渠道配置 */
export interface NotifyConfig {
  /** 钉钉机器人 */
  dingtalk: DingTalkConfig;
  /** 邮件通知 */
  email: EmailConfig;
}

/** 录像模式：变动触发 / 持续录制 / 事件驱动 */
export type RecordingMode = "motion" | "continuous" | "event";

/** 水印位置 */
export type WatermarkPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right";

/** 水印配置 */
export interface WatermarkConfig {
  /** 是否启用水印 */
  enabled: boolean;
  /** 摄像头名称位置 */
  namePosition: WatermarkPosition;
  /** 时间戳位置 */
  timePosition: WatermarkPosition;
  /** 字号 */
  fontSize: number;
}

/** 运行时可修改的设置 */
export interface RuntimeSettings {
  /** 界面和 AI 输出语言 */
  language: string;
  /** 全局变动检测配置 */
  motion: MotionConfig;
  /** AI 检测配置 */
  ai: AiConfig;
  /** 每个摄像头的灵敏度覆盖 */
  cameraOverrides: Record<string, CameraOverride>;
  /** 录像配置 */
  recording: {
    /** 录像模式 */
    mode: RecordingMode;
    /** 无运动后继续录像时间（ms，仅 motion 模式） */
    postMotionDuration: number;
    /** 自动清理天数 */
    retentionDays: number;
    /** 持续录制分段时长（秒） */
    segmentDuration: number;
    /** 编码器：auto / libx264 / h264_v4l2m2m / h264_vaapi / h264_nvenc */
    encoder: string;
    /** VAAPI 设备路径（默认 /dev/dri/renderD128） */
    vaapiDevice: string;
    /** 水印配置 */
    watermark: WatermarkConfig;
    /** 事件前保留时长（ms，仅 event 模式，从环形缓冲区取） */
    eventPreMs: number;
    /** 事件后保留时长（ms，仅 event 模式，持续收集） */
    eventPostMs: number;
    /** 环形缓冲时长（ms，仅 event 模式） */
    bufferDurationMs: number;
    /** 触发录像的事件类型列表（仅 event 模式） */
    eventTriggers: string[];
  };
  /** Webhook 通知配置 */
  webhook: WebhookConfig;
  /** 通知渠道配置 */
  notify: NotifyConfig;
  /** 存储清理配置 */
  cleanup: {
    /** 事件历史保留天数 */
    eventsRetentionDays: number;
    /** 告警记录保留天数 */
    alertsRetentionDays: number;
    /** 检测快照保留天数 */
    snapshotsRetentionDays: number;
    /** 缩略图缓存保留天数 */
    thumbnailsRetentionDays: number;
  };
}

/**
 * 运行时配置管理器
 * 允许通过 API 修改灵敏度、AI 参数等，无需重启
 * 配置变更会自动持久化回 YAML 文件
 */
export class RuntimeConfig {
  private settings: RuntimeSettings;

  constructor(config: AppConfig) {
    /** 尝试从 YAML 文件加载持久化的运行时配置 */
    const persisted = this.loadPersistedSettings();

    this.settings = {
      language: persisted.language ?? "zh-CN",
      motion: { ...config.motion, ...persisted.motion },
      ai: {
        ...config.ai,
        llm: { ...config.ai.llm, ...persisted.ai?.llm },
        models: persisted.ai?.models ?? config.ai.models.map(m => ({ ...m })),
        clip: { ...config.ai.clip, ...persisted.ai?.clip },
      },
      cameraOverrides: persisted.cameraOverrides ?? {},
      recording: {
        mode: persisted.recording?.mode ?? "motion",
        postMotionDuration: persisted.recording?.postMotionDuration ?? 5000,
        retentionDays: persisted.recording?.retentionDays ?? 7,
        segmentDuration: persisted.recording?.segmentDuration ?? 300,
        encoder: persisted.recording?.encoder ?? "auto",
        vaapiDevice: persisted.recording?.vaapiDevice ?? "/dev/dri/renderD128",
        watermark: {
          enabled: persisted.recording?.watermark?.enabled ?? true,
          namePosition: persisted.recording?.watermark?.namePosition ?? "top-left",
          timePosition: persisted.recording?.watermark?.timePosition ?? "bottom-left",
          fontSize: persisted.recording?.watermark?.fontSize ?? 24,
        },
        eventPreMs: persisted.recording?.eventPreMs ?? 15000,
        eventPostMs: persisted.recording?.eventPostMs ?? 30000,
        bufferDurationMs: persisted.recording?.bufferDurationMs ?? 30000,
        eventTriggers: persisted.recording?.eventTriggers ?? ["alert"],
      },
      webhook: persisted.webhook ?? { urls: [] },
      notify: {
        dingtalk: {
          enabled: persisted.notify?.dingtalk?.enabled ?? false,
          webhookUrl: persisted.notify?.dingtalk?.webhookUrl ?? "",
          secret: persisted.notify?.dingtalk?.secret ?? "",
        },
        email: {
          enabled: persisted.notify?.email?.enabled ?? false,
          smtp: persisted.notify?.email?.smtp ?? null,
          from: persisted.notify?.email?.from ?? "",
          to: persisted.notify?.email?.to ?? "",
        },
      },
      cleanup: {
        eventsRetentionDays: persisted.cleanup?.eventsRetentionDays ?? 30,
        alertsRetentionDays: persisted.cleanup?.alertsRetentionDays ?? 90,
        snapshotsRetentionDays: persisted.cleanup?.snapshotsRetentionDays ?? 30,
        thumbnailsRetentionDays: persisted.cleanup?.thumbnailsRetentionDays ?? 7,
      },
    };
  }

  /** 从 YAML 文件加载已持久化的运行时配置 */
  private loadPersistedSettings(): Partial<RuntimeSettings> {
    const configPath = getConfigPath();
    let raw: string;
    try {
      raw = readFileSync(configPath, "utf-8");
    } catch (e) {
      console.warn("[RuntimeConfig] 读取配置文件失败，使用默认值:", e);
      return {};
    }
    let doc: Record<string, unknown>;
    try {
      doc = yaml.load(raw) as Record<string, unknown>;
    } catch {
      console.warn("[RuntimeConfig] 配置文件 YAML 解析失败，使用默认值");
      return {};
    }

    const result: Partial<RuntimeSettings> = {};

    if (typeof doc.language === "string") result.language = doc.language;

    if (doc.motion && typeof doc.motion === "object") {
      const m = doc.motion as Record<string, unknown>;
      result.motion = {
        threshold: m.threshold as number,
        cooldown: m.cooldown as number,
        compareWidth: m.compare_width as number,
        compareHeight: m.compare_height as number,
      };
    }

    if (doc.ai && typeof doc.ai === "object") {
      const a = doc.ai as Record<string, unknown>;
      result.ai = {} as RuntimeSettings["ai"];

      if (a.llm && typeof a.llm === "object") {
        const l = a.llm as Record<string, unknown>;
        result.ai.llm = {
          enabled: l.enabled as boolean,
          apiUrl: (l.api_url as string) ?? "",
          model: (l.model as string) ?? "",
          maxTokens: (l.max_tokens as number) ?? 150,
          interval: (l.interval as number) ?? 10000,
          imageWidth: (l.image_width as number) ?? 640,
          systemPrompt: (l.system_prompt as string) ?? "",
          contextIntervalMs: (l.context_interval_ms as number) ?? 2000,
        };
      }

      if (Array.isArray(a.models)) {
        result.ai.models = (a.models as Array<Record<string, unknown>>).map((m, i) => ({
          id: (m.id as string) ?? `model_${i}`,
          name: (m.name as string) ?? `Model ${i + 1}`,
          apiUrl: (m.api_url as string) ?? (m.apiUrl as string) ?? "",
          model: (m.model as string) ?? "",
          maxTokens: (m.max_tokens as number) ?? 150,
        }));
      }

      if (a.clip && typeof a.clip === "object") {
        const c = a.clip as Record<string, unknown>;
        result.ai.clip = {
          enabled: (c.enabled as boolean) ?? false,
          model: (c.model as string) ?? "jinaai/jina-clip-v2",
          embeddingDim: (c.embedding_dim as number) ?? 512,
        };
      }
    }

    if (doc.recording && typeof doc.recording === "object") {
      const r = doc.recording as Record<string, unknown>;
      result.recording = {
        mode: r.mode as RuntimeSettings["recording"]["mode"],
        postMotionDuration: (r.post_motion_duration as number) ?? 5000,
        retentionDays: (r.retention_days as number) ?? 7,
        segmentDuration: (r.segment_duration as number) ?? 300,
        encoder: (r.encoder as string) ?? "auto",
        vaapiDevice: (r.vaapi_device as string) ?? "/dev/dri/renderD128",
        watermark: {
          enabled: (r.watermark as Record<string, unknown>)?.enabled as boolean ?? true,
          namePosition: (r.watermark as Record<string, unknown>)?.name_position as WatermarkPosition ?? "top-left",
          timePosition: (r.watermark as Record<string, unknown>)?.time_position as WatermarkPosition ?? "bottom-left",
          fontSize: (r.watermark as Record<string, unknown>)?.font_size as number ?? 24,
        },
        eventPreMs: (r.event_pre_ms as number) ?? 15000,
        eventPostMs: (r.event_post_ms as number) ?? 30000,
        bufferDurationMs: (r.buffer_duration_ms as number) ?? 30000,
        eventTriggers: (r.event_triggers as string[]) ?? ["alert"],
      };
    }

    if (doc.camera_overrides && typeof doc.camera_overrides === "object") {
      result.cameraOverrides = doc.camera_overrides as Record<string, CameraOverride>;
    }

    if (doc.webhook && typeof doc.webhook === "object") {
      const w = doc.webhook as Record<string, unknown>;
      result.webhook = {
        urls: Array.isArray(w.urls) ? w.urls as string[] : [],
      };
    }

    if (doc.notify && typeof doc.notify === "object") {
      const n = doc.notify as Record<string, unknown>;
      result.notify = {
        dingtalk: {
          enabled: (n.dingtalk as Record<string, unknown>)?.enabled as boolean ?? false,
          webhookUrl: ((n.dingtalk as Record<string, unknown>)?.webhook_url as string) ?? "",
          secret: ((n.dingtalk as Record<string, unknown>)?.secret as string) ?? "",
        },
        email: {
          enabled: (n.email as Record<string, unknown>)?.enabled as boolean ?? false,
          smtp: (n.email as Record<string, unknown>)?.smtp as EmailSmtpConfig | null ?? null,
          from: ((n.email as Record<string, unknown>)?.from as string) ?? "",
          to: ((n.email as Record<string, unknown>)?.to as string) ?? "",
        },
      };
    }

    if (doc.cleanup && typeof doc.cleanup === "object") {
      const c = doc.cleanup as Record<string, unknown>;
      result.cleanup = {
        eventsRetentionDays: (c.events_retention_days as number) ?? 30,
        alertsRetentionDays: (c.alerts_retention_days as number) ?? 90,
        snapshotsRetentionDays: (c.snapshots_retention_days as number) ?? 30,
        thumbnailsRetentionDays: (c.thumbnails_retention_days as number) ?? 7,
      };
    }

    return result;
  }

  /** 获取当前设置 */
  get(): RuntimeSettings {
    return this.settings;
  }

  /** 从 JSON body 更新设置（API 边界安全入口） */
  patchFromJSON(body: unknown): RuntimeSettings {
    if (!body || typeof body !== "object") return this.settings;
    const obj = body as Record<string, unknown>;

    if (typeof obj.language === "string") this.settings.language = obj.language;

    if (obj.motion && typeof obj.motion === "object") {
      const m = obj.motion as Record<string, unknown>;
      if (typeof m.threshold === "number") this.settings.motion.threshold = m.threshold;
      if (typeof m.cooldown === "number") this.settings.motion.cooldown = m.cooldown;
      if (typeof m.compareWidth === "number") this.settings.motion.compareWidth = m.compareWidth;
      if (typeof m.compareHeight === "number") this.settings.motion.compareHeight = m.compareHeight;
    }

    if (obj.ai && typeof obj.ai === "object") {
      const a = obj.ai as Record<string, unknown>;
      if (a.llm && typeof a.llm === "object") {
        const l = a.llm as Record<string, unknown>;
        if (typeof l.enabled === "boolean") this.settings.ai.llm.enabled = l.enabled;
        if (typeof l.apiUrl === "string") this.settings.ai.llm.apiUrl = l.apiUrl;
        if (typeof l.model === "string") this.settings.ai.llm.model = l.model;
        if (typeof l.maxTokens === "number") this.settings.ai.llm.maxTokens = l.maxTokens;
        if (typeof l.interval === "number") this.settings.ai.llm.interval = l.interval;
        if (typeof l.imageWidth === "number") this.settings.ai.llm.imageWidth = l.imageWidth;
        if (typeof l.systemPrompt === "string") this.settings.ai.llm.systemPrompt = l.systemPrompt;
        if (typeof l.contextIntervalMs === "number") this.settings.ai.llm.contextIntervalMs = l.contextIntervalMs;
      }
      if (Array.isArray(a.models)) {
        this.settings.ai.models = (a.models as Array<Record<string, unknown>>).map((m, i) => ({
          id: (m.id as string) ?? `model_${i}`,
          name: (m.name as string) ?? `Model ${i + 1}`,
          apiUrl: (m.apiUrl as string) ?? "",
          model: (m.model as string) ?? "",
          maxTokens: (m.maxTokens as number) ?? 150,
        }));
      }
      if (a.clip && typeof a.clip === "object") {
        const c = a.clip as Record<string, unknown>;
        if (typeof c.enabled === "boolean") this.settings.ai.clip.enabled = c.enabled;
        if (typeof c.model === "string") this.settings.ai.clip.model = c.model;
        if (typeof c.embeddingDim === "number") this.settings.ai.clip.embeddingDim = c.embeddingDim;
        if (c.candidates && typeof c.candidates === "object") {
          const raw = c.candidates as Record<string, unknown>;
          const parsed: Record<string, string[]> = {};
          for (const [key, val] of Object.entries(raw)) {
            if (Array.isArray(val) && val.every(v => typeof v === "string")) {
              parsed[key] = val;
            }
          }
          this.settings.ai.clip.candidates = parsed;
        }
      }
    }

    if (obj.recording && typeof obj.recording === "object") {
      const r = obj.recording as Record<string, unknown>;
      if (r.mode === "motion" || r.mode === "continuous" || r.mode === "event") this.settings.recording.mode = r.mode;
      if (typeof r.postMotionDuration === "number") this.settings.recording.postMotionDuration = r.postMotionDuration;
      if (typeof r.retentionDays === "number") this.settings.recording.retentionDays = r.retentionDays;
      if (typeof r.segmentDuration === "number") this.settings.recording.segmentDuration = r.segmentDuration;
      if (typeof r.encoder === "string") this.settings.recording.encoder = r.encoder;
      if (typeof r.vaapiDevice === "string") this.settings.recording.vaapiDevice = r.vaapiDevice;
      if (typeof r.eventPreMs === "number") this.settings.recording.eventPreMs = r.eventPreMs;
      if (typeof r.eventPostMs === "number") this.settings.recording.eventPostMs = r.eventPostMs;
      if (typeof r.bufferDurationMs === "number") this.settings.recording.bufferDurationMs = r.bufferDurationMs;
      if (Array.isArray(r.eventTriggers)) this.settings.recording.eventTriggers = r.eventTriggers.filter((t: unknown): t is string => typeof t === "string");
      if (r.watermark && typeof r.watermark === "object") {
        const wm = r.watermark as Record<string, unknown>;
        if (typeof wm.enabled === "boolean") this.settings.recording.watermark.enabled = wm.enabled;
        if (typeof wm.fontSize === "number") this.settings.recording.watermark.fontSize = wm.fontSize;
        const validPositions = ["top-left", "top-right", "bottom-left", "bottom-right"];
        if (typeof wm.namePosition === "string" && validPositions.includes(wm.namePosition)) {
          this.settings.recording.watermark.namePosition = wm.namePosition as WatermarkPosition;
        }
        if (typeof wm.timePosition === "string" && validPositions.includes(wm.timePosition)) {
          this.settings.recording.watermark.timePosition = wm.timePosition as WatermarkPosition;
        }
      }
    }

    if (obj.cameraOverrides && typeof obj.cameraOverrides === "object") {
      this.settings.cameraOverrides = { ...this.settings.cameraOverrides, ...(obj.cameraOverrides as Record<string, CameraOverride>) };
    }

    if (obj.webhook && typeof obj.webhook === "object") {
      const w = obj.webhook as Record<string, unknown>;
      if (Array.isArray(w.urls)) {
        this.settings.webhook.urls = w.urls.filter((u): u is string => typeof u === "string");
      }
    }

    if (obj.notify && typeof obj.notify === "object") {
      const n = obj.notify as Record<string, unknown>;
      if (n.dingtalk && typeof n.dingtalk === "object") {
        const d = n.dingtalk as Record<string, unknown>;
        if (typeof d.enabled === "boolean") this.settings.notify.dingtalk.enabled = d.enabled;
        if (typeof d.webhookUrl === "string") this.settings.notify.dingtalk.webhookUrl = d.webhookUrl;
        if (typeof d.secret === "string") this.settings.notify.dingtalk.secret = d.secret;
      }
      if (n.email && typeof n.email === "object") {
        const e = n.email as Record<string, unknown>;
        if (typeof e.enabled === "boolean") this.settings.notify.email.enabled = e.enabled;
        if (typeof e.from === "string") this.settings.notify.email.from = e.from;
        if (typeof e.to === "string") this.settings.notify.email.to = e.to;
        if (e.smtp && typeof e.smtp === "object") {
          const s = e.smtp as Record<string, unknown>;
          this.settings.notify.email.smtp = {
            host: typeof s.host === "string" ? s.host : "",
            port: typeof s.port === "number" ? s.port : 465,
            secure: typeof s.secure === "boolean" ? s.secure : true,
            user: typeof s.user === "string" ? s.user : "",
            pass: typeof s.pass === "string" ? s.pass : "",
          };
        }
      }
    }

    if (obj.cleanup && typeof obj.cleanup === "object") {
      const c = obj.cleanup as Record<string, unknown>;
      if (typeof c.eventsRetentionDays === "number") this.settings.cleanup.eventsRetentionDays = c.eventsRetentionDays;
      if (typeof c.alertsRetentionDays === "number") this.settings.cleanup.alertsRetentionDays = c.alertsRetentionDays;
      if (typeof c.snapshotsRetentionDays === "number") this.settings.cleanup.snapshotsRetentionDays = c.snapshotsRetentionDays;
      if (typeof c.thumbnailsRetentionDays === "number") this.settings.cleanup.thumbnailsRetentionDays = c.thumbnailsRetentionDays;
    }

    /** 持久化到 YAML 文件（后台执行，不阻塞响应） */
    saveRuntimeToYaml(this.settings as unknown as Record<string, unknown>).catch(err => {
      console.error("[RuntimeConfig] 持久化配置失败:", err);
    });

    return this.settings;
  }

  /** 更新设置（部分更新，类型安全） */
  patch(updates: Partial<RuntimeSettings>): RuntimeSettings {
    if (updates.motion) {
      this.settings.motion = { ...this.settings.motion, ...updates.motion };
    }
    if (updates.ai) {
      this.settings.ai = { ...this.settings.ai, ...updates.ai };
    }
    if (updates.recording) {
      this.settings.recording = { ...this.settings.recording, ...updates.recording };
    }
    if (updates.cameraOverrides) {
      this.settings.cameraOverrides = { ...this.settings.cameraOverrides, ...updates.cameraOverrides };
    }
    if (updates.webhook) {
      this.settings.webhook = { ...this.settings.webhook, ...updates.webhook };
    }
    if (updates.notify) {
      this.settings.notify = {
        dingtalk: { ...this.settings.notify.dingtalk, ...updates.notify.dingtalk },
        email: { ...this.settings.notify.email, ...updates.notify.email },
      };
    }
    if (updates.cleanup) {
      this.settings.cleanup = { ...this.settings.cleanup, ...updates.cleanup };
    }
    return this.settings;
  }

  /** 获取某个摄像头的有效变动检测配置（考虑覆盖） */
  getMotionConfig(cameraId: string): MotionConfig {
    const override = this.settings.cameraOverrides[cameraId];
    if (!override) return this.settings.motion;
    return {
      ...this.settings.motion,
      ...(override.motionThreshold !== undefined && { threshold: override.motionThreshold }),
      ...(override.motionCooldown !== undefined && { cooldown: override.motionCooldown }),
    };
  }

  /** 重置某个摄像头的覆盖 */
  resetCameraOverride(cameraId: string): void {
    const overrides = { ...this.settings.cameraOverrides };
    delete overrides[cameraId];
    this.settings.cameraOverrides = overrides;
  }
}
