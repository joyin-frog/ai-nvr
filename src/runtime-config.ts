import { type AppConfig, type MotionConfig } from "@/config";
import { type AiConfig } from "@/ai/types";

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
  /** AI 置信度阈值覆盖（0-1） */
  aiThreshold?: number;
  /** AI 连续检测间隔覆盖（ms） */
  aiInterval?: number;
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

/** 录像模式：变动触发 / 持续录制 */
export type RecordingMode = "motion" | "continuous";

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
    /** 水印配置 */
    watermark: WatermarkConfig;
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
 */
export class RuntimeConfig {
  private settings: RuntimeSettings;

  constructor(config: AppConfig) {
    this.settings = {
      motion: { ...config.motion },
      ai: { ...config.ai },
      cameraOverrides: {},
      recording: {
        mode: "motion",
        postMotionDuration: 5000,
        retentionDays: 7,
        segmentDuration: 300,
        encoder: "auto",
        watermark: {
          enabled: true,
          namePosition: "top-left",
          timePosition: "bottom-left",
          fontSize: 24,
        },
      },
      webhook: {
        urls: [],
      },
      notify: {
        dingtalk: {
          enabled: false,
          webhookUrl: "",
          secret: "",
        },
        email: {
          enabled: false,
          smtp: null,
          from: "",
          to: "",
        },
      },
      cleanup: {
        eventsRetentionDays: 30,
        alertsRetentionDays: 90,
        snapshotsRetentionDays: 30,
        thumbnailsRetentionDays: 7,
      },
    };
  }

  /** 获取当前设置 */
  get(): RuntimeSettings {
    return this.settings;
  }

  /** 从 JSON body 更新设置（API 边界安全入口） */
  patchFromJSON(body: unknown): RuntimeSettings {
    if (!body || typeof body !== "object") return this.settings;
    const obj = body as Record<string, unknown>;

    if (obj.motion && typeof obj.motion === "object") {
      const m = obj.motion as Record<string, unknown>;
      if (typeof m.threshold === "number") this.settings.motion.threshold = m.threshold;
      if (typeof m.cooldown === "number") this.settings.motion.cooldown = m.cooldown;
      if (typeof m.compareWidth === "number") this.settings.motion.compareWidth = m.compareWidth;
      if (typeof m.compareHeight === "number") this.settings.motion.compareHeight = m.compareHeight;
    }

    if (obj.ai && typeof obj.ai === "object") {
      const a = obj.ai as Record<string, unknown>;
      if (typeof a.enabled === "boolean") this.settings.ai.enabled = a.enabled;
      if (typeof a.model === "string") this.settings.ai.model = a.model;
      if (typeof a.threshold === "number") this.settings.ai.threshold = a.threshold;
      if (typeof a.maxDetections === "number") this.settings.ai.maxDetections = a.maxDetections;
      if (typeof a.inputWidth === "number") this.settings.ai.inputWidth = a.inputWidth;
      if (typeof a.showBoxes === "boolean") this.settings.ai.showBoxes = a.showBoxes;
      if (a.mode === "motion" || a.mode === "continuous") this.settings.ai.mode = a.mode;
      if (typeof a.interval === "number") this.settings.ai.interval = a.interval;
      if (typeof a.autoMatchThreshold === "number") this.settings.ai.autoMatchThreshold = a.autoMatchThreshold;
      if (typeof a.speedThreshold === "number") this.settings.ai.speedThreshold = a.speedThreshold;
      if (typeof a.loiterThreshold === "number") this.settings.ai.loiterThreshold = a.loiterThreshold;
      if (Array.isArray(a.importantLabels)) this.settings.ai.importantLabels = a.importantLabels.filter((l: unknown): l is string => typeof l === "string");
    }

    if (obj.recording && typeof obj.recording === "object") {
      const r = obj.recording as Record<string, unknown>;
      if (r.mode === "motion" || r.mode === "continuous") this.settings.recording.mode = r.mode;
      if (typeof r.postMotionDuration === "number") this.settings.recording.postMotionDuration = r.postMotionDuration;
      if (typeof r.retentionDays === "number") this.settings.recording.retentionDays = r.retentionDays;
      if (typeof r.segmentDuration === "number") this.settings.recording.segmentDuration = r.segmentDuration;
      if (typeof r.encoder === "string") this.settings.recording.encoder = r.encoder;
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

  /** 获取某个摄像头的有效 AI 推理分辨率（考虑覆盖） */
  getAiInputWidth(cameraId: string): number {
    const override = this.settings.cameraOverrides[cameraId];
    if (override?.inputWidth) return override.inputWidth;
    return this.settings.ai.inputWidth;
  }

  /** 获取某个摄像头的有效 AI 置信度阈值（考虑覆盖） */
  getAiThreshold(cameraId: string): number {
    const override = this.settings.cameraOverrides[cameraId];
    if (override?.aiThreshold !== undefined) return override.aiThreshold;
    return this.settings.ai.threshold;
  }

  /** 获取某个摄像头的有效 AI 检测间隔（考虑覆盖） */
  getAiInterval(cameraId: string): number {
    const override = this.settings.cameraOverrides[cameraId];
    if (override?.aiInterval !== undefined) return override.aiInterval;
    return this.settings.ai.interval;
  }

  /** 重置某个摄像头的覆盖 */
  resetCameraOverride(cameraId: string): void {
    const overrides = { ...this.settings.cameraOverrides };
    delete overrides[cameraId];
    this.settings.cameraOverrides = overrides;
  }
}
