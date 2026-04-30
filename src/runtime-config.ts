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
}

/** Webhook 通知配置 */
export interface WebhookConfig {
  /** Webhook 推送 URL 列表 */
  urls: string[];
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
    /** 无运动后继续录像时间（ms） */
    postMotionDuration: number;
    /** 自动清理天数 */
    retentionDays: number;
  };
  /** Webhook 通知配置 */
  webhook: WebhookConfig;
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
        postMotionDuration: 5000,
        retentionDays: 7,
      },
      webhook: {
        urls: [],
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
      if (typeof a.threshold === "number") this.settings.ai.threshold = a.threshold;
      if (typeof a.maxDetections === "number") this.settings.ai.maxDetections = a.maxDetections;
    }

    if (obj.recording && typeof obj.recording === "object") {
      const r = obj.recording as Record<string, unknown>;
      if (typeof r.postMotionDuration === "number") this.settings.recording.postMotionDuration = r.postMotionDuration;
      if (typeof r.retentionDays === "number") this.settings.recording.retentionDays = r.retentionDays;
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
