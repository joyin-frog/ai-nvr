import { readFileSync, watchFile } from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import yaml from "js-yaml";
import { type AiConfig } from "@/ai/types";
import { type ClipConfig } from "@/ai/clip-service";

/** 配置文件写操作互斥锁（防止并发 TOCTOU 竞态） */
let configWriteQueue: Promise<void> = Promise.resolve();
function withConfigLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = configWriteQueue;
  let resolve_: (value: void) => void;
  configWriteQueue = new Promise<void>(r => { resolve_ = r; });
  return prev.then(async () => {
    const result = await fn();
    resolve_();
    return result;
  });
}

/** RTSP 流地址来源（直接连摄像机） */
export interface StreamSource {
  /** 主码流 RTSP 地址 */
  hd: string;
  /** 子码流 RTSP 地址 */
  sd: string;
}

/** PTZ 配置 */
export interface PtzConfig {
  /** 是否启用 PTZ */
  enabled: boolean;
  /** 驱动类型: "onvif"（默认）或 "tplink" */
  driver?: "onvif" | "tplink";
  /** 设备主机地址 */
  host: string;
  /** 端口（默认 80） */
  port: number;
  /** 用户名 */
  username: string;
  /** 密码 */
  password: string;
  /** NVR 通道号（默认 1） */
  channel?: number;
}

/** 单个摄像头配置 */
export interface CameraConfig {
  /** 摄像头唯一标识 */
  id: string;
  /** 友好名称 */
  friendlyName: string;
  /** 是否启用 */
  enabled: boolean;
  /** RTSP 流地址 */
  stream: StreamSource;
  /** 帧提取分辨率宽度（0 = 原始分辨率） */
  detectWidth: number;
  /** 帧提取分辨率高度（0 = 原始） */
  detectHeight: number;
  /** 帧提取帧率（fps） */
  detectFps: number;
  /** JPEG 编码质量（1-31，越小质量越高，默认 5） */
  jpegQuality: number;
  /** 所属分组（可选，用于前端筛选） */
  group: string;
  /** PTZ 配置（可选，仅支持云台的摄像头） */
  ptz?: PtzConfig;
}

/** 变动检测配置 */
export interface MotionConfig {
  /** 变动像素占比阈值（0-1），超过此值判定为有变动 */
  threshold: number;
  /** 变动事件最小间隔（毫秒），避免频繁触发 */
  cooldown: number;
  /** 用于比对的缩放分辨率宽度 */
  compareWidth: number;
  /** 用于比对的缩放分辨率高度 */
  compareHeight: number;
}

/** 认证配置 */
export interface AuthConfig {
  /** 访问令牌，为空则不启用认证 */
  token: string;
}

/** 服务配置 */
export interface ServerConfig {
  /** HTTP 监听端口 */
  port: number;
}

/** 存储配置 */
export interface StorageConfig {
  /** 数据存储根目录 */
  dataDir: string;
}

/** 应用总配置 */
export interface AppConfig {
  /** ffmpeg 可执行文件路径 */
  ffmpegPath: string;
  /** 摄像头列表 */
  cameras: CameraConfig[];
  /** 变动检测配置 */
  motion: MotionConfig;
  /** AI 检测配置 */
  ai: AiConfig;
  /** 认证配置 */
  auth: AuthConfig;
  /** 服务配置 */
  server: ServerConfig;
  /** 存储配置 */
  storage: StorageConfig;
}

/** 解析摄像头 PTZ 配置 */
function parsePtzConfig(cam: Record<string, unknown>): PtzConfig | undefined {
  const ptz = cam.ptz as Record<string, unknown> | undefined;
  if (!ptz || ptz.enabled !== true) return undefined;
  /** 从 RTSP 流地址推断 NVR 通道号（如 stream1&channel=2 → 2） */
  const hdStream = ((cam.stream as Record<string, unknown>)?.hd as string) ?? "";
  const channelMatch = hdStream.match(/[&?]channel=(\d+)/);
  const channel = channelMatch ? parseInt(channelMatch[1]!, 10) : 1;

  return {
    enabled: true,
    driver: (ptz.driver as "onvif" | "tplink") ?? "onvif",
    host: ptz.host as string,
    port: (ptz.port as number) ?? 80,
    username: ptz.username as string,
    password: ptz.password as string,
    channel: (ptz.channel as number) ?? channel,
  };
}

/** 配置文件路径（模块级别缓存） */
let configFilePath: string;

/** 加载并解析配置文件 */
export function loadConfig(configPath?: string): AppConfig {
  configFilePath = configPath ?? resolve(import.meta.dir, "../nvr_config.yml");
  const raw = readFileSync(configFilePath, "utf-8");
  const doc = yaml.load(raw) as Record<string, unknown>;

  const camerasNode = doc.cameras as Record<string, Record<string, unknown>>;

  const ffmpegPath = (doc.ffmpeg_path as string)
    ? resolve((doc.ffmpeg_path as string).replace(/^~/, process.env.HOME!))
    : resolve(process.env.HOME!, "tools/ffmpeg/bin/ffmpeg");

  const cameras: CameraConfig[] = [];
  for (const [id, cam] of Object.entries(camerasNode)) {
    if (cam.enabled === false) continue;

    const streamNode = cam.stream as Record<string, unknown> | undefined;
    const hd = (streamNode?.hd as string) ?? "";
    const sd = (streamNode?.sd as string) ?? "";

    cameras.push({
      id,
      friendlyName: (cam.friendly_name as string) ?? id,
      enabled: true,
      stream: { hd, sd },
      detectWidth: ((cam.detect as Record<string, unknown>)?.width as number) ?? 0,
      detectHeight: ((cam.detect as Record<string, unknown>)?.height as number) ?? 0,
      detectFps: (cam.detect as Record<string, unknown>)?.fps as number ?? 15,
      jpegQuality: ((cam.detect as Record<string, unknown>)?.jpeg_quality as number) ?? 10,
      group: (cam.group as string) ?? "",
      ptz: parsePtzConfig(cam),
    });
  }

  /** AI 配置 */
  const aiNode = doc.ai as Record<string, unknown> | undefined;

  /** 认证配置 */
  const authNode = doc.auth as Record<string, unknown> | undefined;

  const config: AppConfig = {
    ffmpegPath,
    cameras,
    motion: {
      threshold: ((doc.motion as Record<string, unknown>)?.threshold as number) ?? 0.01,
      cooldown: ((doc.motion as Record<string, unknown>)?.cooldown as number) ?? 1000,
      compareWidth: ((doc.motion as Record<string, unknown>)?.compare_width as number) ?? 160,
      compareHeight: ((doc.motion as Record<string, unknown>)?.compare_height as number) ?? 120,
    },
    ai: {
      llm: parseLlmConfig(aiNode?.llm as Record<string, unknown> | undefined),
      models: parseModelsConfig(aiNode?.models as Array<Record<string, unknown>> | undefined, aiNode?.llm as Record<string, unknown> | undefined),
      clip: parseClipConfig(aiNode?.clip as Record<string, unknown> | undefined),
    },
    auth: {
      token: (authNode?.token as string) ?? "",
    },
    server: {
      port: ((doc.server as Record<string, unknown>)?.port as number) || 3100,
    },
    storage: {
      dataDir: (doc.storage as Record<string, unknown>)?.data_dir as string
        ?? resolve(import.meta.dir, "../data"),
    },
  };

  validateConfig(config);
  return config;
}

/** 运行时配置校验，发现不合理值时 warn 并自动修正 */
function validateConfig(config: AppConfig): void {
  const warnings: string[] = [];

  if (config.motion.threshold <= 0 || config.motion.threshold > 1) {
    warnings.push(`motion.threshold=${config.motion.threshold} 不在 (0,1] 范围，已修正为 0.01`);
    config.motion.threshold = 0.01;
  }
  if (config.motion.cooldown < 0) {
    warnings.push(`motion.cooldown=${config.motion.cooldown} 为负数，已修正为 1000`);
    config.motion.cooldown = 1000;
  }
  if (config.server.port < 1 || config.server.port > 65535) {
    warnings.push(`server.port=${config.server.port} 不在合法端口范围，已修正为 3100`);
    config.server.port = 3100;
  }

  for (const cam of config.cameras) {
    if (cam.detectFps <= 0 || cam.detectFps > 120) {
      warnings.push(`摄像头 ${cam.id}: detectFps=${cam.detectFps} 不合理，已修正为 15`);
      cam.detectFps = 15;
    }
    if (cam.jpegQuality < 1 || cam.jpegQuality > 31) {
      warnings.push(`摄像头 ${cam.id}: jpegQuality=${cam.jpegQuality} 不在 [1,31]，已修正为 10`);
      cam.jpegQuality = 10;
    }
    if (cam.enabled && !cam.stream.hd && !cam.stream.sd) {
      warnings.push(`摄像头 ${cam.id}: 已启用但未配置任何 RTSP 流地址`);
    }
  }

  if (config.ai.llm.enabled) {
    if (config.ai.llm.interval < 1000) {
      warnings.push(`ai.llm.interval=${config.ai.llm.interval} 过低（最小 1000ms），已修正`);
      config.ai.llm.interval = 1000;
    }
    if (!config.ai.llm.apiUrl) {
      warnings.push("ai.llm 已启用但未配置 api_url，将跳过 LLM 调用");
    }
  }

  if (warnings.length > 0) {
    for (const w of warnings) console.warn("[Config] " + w);
  }
}

/** 解析 LLM 配置 */
function parseLlmConfig(llmNode: Record<string, unknown> | undefined): import("@/ai/types").AiConfig["llm"] {
  if (!llmNode) {
    return {
      enabled: false,
      apiUrl: "",
      model: "",
      maxTokens: 150,
      interval: 10000,
      imageWidth: 640,
      systemPrompt: "",
      contextIntervalMs: 2000,
    };
  }
  return {
    enabled: (llmNode.enabled as boolean) ?? false,
    apiUrl: (llmNode.api_url as string) ?? "",
    model: (llmNode.model as string) ?? "",
    maxTokens: (llmNode.max_tokens as number) ?? 150,
    interval: (llmNode.interval as number) ?? 10000,
    imageWidth: (llmNode.image_width as number) ?? 640,
    systemPrompt: (llmNode.system_prompt as string) ?? "",
    contextIntervalMs: (llmNode.context_interval_ms as number) ?? 2000,
  };
}

/** 解析多模型配置（从 YAML models 数组，兼容旧的单模型 llm 配置） */
function parseModelsConfig(modelsNode: Array<Record<string, unknown>> | undefined, llmNode: Record<string, unknown> | undefined): import("@/ai/multimodal-analyzer").LlmModelConfig[] {
  if (Array.isArray(modelsNode) && modelsNode.length > 0) {
    return modelsNode.map((m, i) => ({
      id: (m.id as string) ?? `model_${i}`,
      name: (m.name as string) ?? (m.model as string) ?? `Model ${i + 1}`,
      apiUrl: (m.api_url as string) ?? (m.apiUrl as string) ?? "",
      model: (m.model as string) ?? "",
      maxTokens: (m.max_tokens as number) ?? (m.maxTokens as number) ?? 150,
    }));
  }
  /** 兼容旧配置：从 llm 节点构建默认模型 */
  const apiUrl = (llmNode?.api_url as string) ?? (llmNode?.apiUrl as string) ?? "";
  const model = (llmNode?.model as string) ?? "";
  if (!apiUrl || !model) return [];
  return [{
    id: "default",
    name: model,
    apiUrl,
    model,
    maxTokens: (llmNode?.max_tokens as number) ?? 150,
  }];
}

/** 解析 CLIP 零样本分类配置 */
function parseClipConfig(clipNode: Record<string, unknown> | undefined): ClipConfig {
  if (!clipNode) {
    return {
      enabled: false,
      model: "jinaai/jina-clip-v2",
      embeddingDim: 512,
    };
  }
  /** 解析用户自定义候选标签 { "person": ["a person in uniform", ...], ... } */
  let candidates: Record<string, string[]> | undefined;
  if (clipNode.candidates && typeof clipNode.candidates === "object") {
    const raw = clipNode.candidates as Record<string, unknown>;
    candidates = {};
    for (const [key, val] of Object.entries(raw)) {
      if (Array.isArray(val) && val.every(v => typeof v === "string")) {
        candidates[key] = val;
      }
    }
    if (Object.keys(candidates).length === 0) candidates = undefined;
  }
  return {
    enabled: (clipNode.enabled as boolean) ?? false,
    model: (clipNode.model as string) ?? "jinaai/jina-clip-v2",
    embeddingDim: (clipNode.embedding_dim as number) ?? 512,
    candidates,
  };
}

/** 获取配置文件路径 */
export function getConfigPath(): string {
  return configFilePath;
}

/** 添加摄像头到配置文件并写回 YAML，返回更新后的配置 */
export function addCameraToConfig(cam: { id: string; friendlyName: string; hdUrl: string; sdUrl: string; detectFps?: number; group?: string }): Promise<AppConfig> {
  return withConfigLock(async () => {
    const YAML = await import("yaml");
    const raw = await Bun.file(configFilePath).text();
    const doc = YAML.parseDocument(raw);

    doc.setIn(["cameras", cam.id], {
      enabled: true,
      friendly_name: cam.friendlyName,
      stream: { hd: cam.hdUrl, sd: cam.sdUrl },
      ...(cam.group ? { group: cam.group } : {}),
      record: { enabled: true, continuous: { days: 0 }, motion: { days: 7 } },
      detect: { enabled: true, width: 0, height: 0, fps: cam.detectFps ?? 25 },
    });

    await writeFile(configFilePath, doc.toString(), "utf-8");
    return loadConfig();
  });
}

/** 删除摄像头从配置文件，返回更新后的配置 */
export function removeCameraFromConfig(cameraId: string): Promise<AppConfig> {
  return withConfigLock(async () => {
    const YAML = await import("yaml");
    const raw = await Bun.file(configFilePath).text();
    const doc = YAML.parseDocument(raw);

    doc.deleteIn(["cameras", cameraId]);

    await writeFile(configFilePath, doc.toString(), "utf-8");
    return loadConfig();
  });
}

/** 更新摄像头名称，返回更新后的配置 */
export function updateCameraInConfig(cameraId: string, updates: { friendlyName?: string; hdUrl?: string; sdUrl?: string; group?: string }): Promise<AppConfig> {
  return withConfigLock(async () => {
    const YAML = await import("yaml");
    const raw = await Bun.file(configFilePath).text();
    const doc = YAML.parseDocument(raw);

    const camPath = ["cameras", cameraId];
    if (!doc.hasIn(camPath)) throw new Error(`摄像头 ${cameraId} 不存在`);

    if (updates.friendlyName) doc.setIn([...camPath, "friendly_name"], updates.friendlyName);
    if (updates.hdUrl) doc.setIn([...camPath, "stream", "hd"], updates.hdUrl);
    if (updates.sdUrl) doc.setIn([...camPath, "stream", "sd"], updates.sdUrl);
    if (updates.group !== undefined) doc.setIn([...camPath, "group"], updates.group);

    await writeFile(configFilePath, doc.toString(), "utf-8");
    return loadConfig();
  });
}

/** 监听配置文件变更，触发回调 */
export function watchConfig(configPath: string | undefined, onChange: (config: AppConfig) => void): void {
  const path = configPath ?? resolve(import.meta.dir, "../nvr_config.yml");
  let lastReload = 0;

  watchFile(path, { interval: 2000 }, () => {
    /** 防抖：2秒内不重复触发 */
    const now = Date.now();
    if (now - lastReload < 2000) return;
    lastReload = now;

    try {
      const newConfig = loadConfig(configPath);
      onChange(newConfig);
      console.log("[Config] 配置已热重载");
    } catch (err) {
      console.error("[Config] 配置重载失败:", err);
    }
  });
}

/** 将运行时设置持久化回 YAML 文件（保留注释，settings 来自 RuntimeConfig.get()） */
export function saveRuntimeToYaml(settings: Record<string, unknown>): Promise<void> {
  return withConfigLock(async () => {
    const raw = await Bun.file(configFilePath).text();
    const YAML = await import("yaml");
    const doc = YAML.parseDocument(raw);

    const s = settings as unknown as import("@/runtime-config").RuntimeSettings;

    /** 在 YAML 文档中设置嵌套路径的值 */
    const set = (path: string[], value: unknown) => {
      doc.setIn(path, value);
    };

    set(["language"], s.language);

    set(["motion", "threshold"], s.motion.threshold);
    set(["motion", "cooldown"], s.motion.cooldown);
    set(["motion", "compare_width"], s.motion.compareWidth);
    set(["motion", "compare_height"], s.motion.compareHeight);

    set(["ai", "llm", "enabled"], s.ai.llm.enabled);
    set(["ai", "llm", "api_url"], s.ai.llm.apiUrl);
    set(["ai", "llm", "model"], s.ai.llm.model);
    set(["ai", "llm", "max_tokens"], s.ai.llm.maxTokens);
    set(["ai", "llm", "interval"], s.ai.llm.interval);
    set(["ai", "llm", "image_width"], s.ai.llm.imageWidth);
    set(["ai", "llm", "system_prompt"], s.ai.llm.systemPrompt);
    set(["ai", "llm", "context_interval_ms"], s.ai.llm.contextIntervalMs);

    set(["ai", "models"], s.ai.models.map(m => ({
      id: m.id, name: m.name, api_url: m.apiUrl, model: m.model, max_tokens: m.maxTokens,
    })));

    set(["ai", "clip", "enabled"], s.ai.clip.enabled);
    set(["ai", "clip", "model"], s.ai.clip.model);
    set(["ai", "clip", "embedding_dim"], s.ai.clip.embeddingDim);
    if (s.ai.clip.candidates) {
      set(["ai", "clip", "candidates"], s.ai.clip.candidates);
    }

    set(["recording", "mode"], s.recording.mode);
    set(["recording", "post_motion_duration"], s.recording.postMotionDuration);
    set(["recording", "retention_days"], s.recording.retentionDays);
    set(["recording", "segment_duration"], s.recording.segmentDuration);
    set(["recording", "encoder"], s.recording.encoder);
    set(["recording", "vaapi_device"], s.recording.vaapiDevice);
    set(["recording", "watermark", "enabled"], s.recording.watermark.enabled);
    set(["recording", "watermark", "name_position"], s.recording.watermark.namePosition);
    set(["recording", "watermark", "time_position"], s.recording.watermark.timePosition);
    set(["recording", "watermark", "font_size"], s.recording.watermark.fontSize);
    set(["recording", "event_pre_ms"], s.recording.eventPreMs);
    set(["recording", "event_post_ms"], s.recording.eventPostMs);
    set(["recording", "buffer_duration_ms"], s.recording.bufferDurationMs);
    set(["recording", "event_triggers"], s.recording.eventTriggers);

    if (Object.keys(s.cameraOverrides).length > 0) {
      set(["camera_overrides"], s.cameraOverrides);
    } else if (doc.has("camera_overrides")) {
      doc.delete("camera_overrides");
    }

    set(["webhook", "urls"], s.webhook.urls);

    set(["notify", "dingtalk", "enabled"], s.notify.dingtalk.enabled);
    set(["notify", "dingtalk", "webhook_url"], s.notify.dingtalk.webhookUrl);
    set(["notify", "dingtalk", "secret"], s.notify.dingtalk.secret);

    set(["notify", "email", "enabled"], s.notify.email.enabled);
    if (s.notify.email.smtp) {
      set(["notify", "email", "smtp", "host"], s.notify.email.smtp.host);
      set(["notify", "email", "smtp", "port"], s.notify.email.smtp.port);
      set(["notify", "email", "smtp", "secure"], s.notify.email.smtp.secure);
      set(["notify", "email", "smtp", "user"], s.notify.email.smtp.user);
      set(["notify", "email", "smtp", "pass"], s.notify.email.smtp.pass);
    }
    set(["notify", "email", "from"], s.notify.email.from);
    set(["notify", "email", "to"], s.notify.email.to);

    set(["cleanup", "events_retention_days"], s.cleanup.eventsRetentionDays);
    set(["cleanup", "alerts_retention_days"], s.cleanup.alertsRetentionDays);
    set(["cleanup", "snapshots_retention_days"], s.cleanup.snapshotsRetentionDays);
    set(["cleanup", "thumbnails_retention_days"], s.cleanup.thumbnailsRetentionDays);

    await writeFile(configFilePath, doc.toString(), "utf-8");
  });
}
