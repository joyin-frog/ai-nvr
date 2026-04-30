import { readFileSync, watchFile } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import { type AiConfig } from "@/ai/types";

/** RTSP 流地址来源（直接连摄像机） */
export interface StreamSource {
  /** 主码流 RTSP 地址 */
  hd: string;
  /** 子码流 RTSP 地址 */
  sd: string;
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
  /** 检测分辨率宽度 */
  detectWidth: number;
  /** 检测分辨率高度 */
  detectHeight: number;
  /** 检测帧率（fps） */
  detectFps: number;
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

/** 服务配置 */
export interface ServerConfig {
  /** HTTP 监听端口 */
  port: number;
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
  /** 服务配置 */
  server: ServerConfig;
}

/** 从 nvr_config.yml 中的 go2rtc.streams 提取 RTSP 地址 */
function extractStreamUrl(
  streams: Record<string, string[]>,
  cameraId: string,
  suffix: string,
): string {
  /** key 格式为 "摄像头id_码流后缀"，如 ipc_gun_hd */
  const key = `${cameraId}_${suffix}`;
  const entries = streams[key];
  if (!entries || entries.length === 0) {
    throw new Error(`配置中未找到流: ${key}`);
  }
  return entries[0]!;
}

/** 加载并解析配置文件 */
export function loadConfig(configPath?: string): AppConfig {
  const path = configPath ?? resolve(import.meta.dir, "../nvr_config.yml");
  const raw = readFileSync(path, "utf-8");
  const doc = yaml.load(raw) as Record<string, unknown>;

  const camerasNode = doc.cameras as Record<string, Record<string, unknown>>;
  const go2rtc = doc.go2rtc as { streams: Record<string, string[]> };

  /** 默认值 */
  const ffmpegPath = resolve(process.env.HOME!, "tools/ffmpeg/bin/ffmpeg");

  const cameras: CameraConfig[] = [];
  for (const [id, cam] of Object.entries(camerasNode)) {
    if (cam.enabled === false) continue;

    cameras.push({
      id,
      friendlyName: (cam.friendly_name as string) ?? id,
      enabled: true,
      stream: {
        hd: extractStreamUrl(go2rtc.streams, id, "hd"),
        sd: extractStreamUrl(go2rtc.streams, id, "sd"),
      },
      /** 检测用分辨率（独立于原始分辨率，用于 ffmpeg 缩放输出） */
      detectWidth: 640,
      detectHeight: 360,
      detectFps: (cam.detect as Record<string, unknown>)?.fps as number ?? 5,
    });
  }

  /** AI 配置 */
  const aiNode = doc.ai as Record<string, unknown> | undefined;

  return {
    ffmpegPath,
    cameras,
    motion: {
      threshold: 0.01,
      cooldown: 1000,
      compareWidth: 160,
      compareHeight: 120,
    },
    ai: {
      enabled: (aiNode?.enabled as boolean) ?? true,
      model: (aiNode?.model as string) ?? "Xenova/detr-resnet-50",
      threshold: (aiNode?.threshold as number) ?? 0.5,
      maxDetections: (aiNode?.max_detections as number) ?? 20,
    },
    server: {
      port: 3100,
    },
  };
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
