import { mkdirSync } from "node:fs";
import sharp from "sharp";
import { join } from "node:path";
import { loadConfig } from "@/config";
import { EventBus } from "@/event-bus";
import { CameraManager } from "@/camera/manager";
import { MotionDetector } from "@/detection/motion";
import { AiDetector } from "@/ai/detector";
import { Annotator } from "@/ai/annotator";
import { startServer } from "@/api";
import { EventStorage } from "@/storage/events";

/** 设置 Hugging Face 镜像（国内网络加速模型下载） */
process.env.HF_ENDPOINT = process.env.HF_ENDPOINT ?? "https://hf-mirror.com";

/** 全局事件总线 */
const eventBus = new EventBus();

/** 加载配置 */
const config = loadConfig();
console.log(`[Config] 已加载配置，${config.cameras.length} 个摄像头`);

/** 摄像头管理器 */
const cameraManager = new CameraManager(config, eventBus);

/** 变动检测器 */
const motionDetector = new MotionDetector(config.motion, eventBus);

/** AI 检测器 */
const annotator = new Annotator();
const aiDetector = new AiDetector(config.ai, eventBus, annotator);

/** 启动变动检测 */
motionDetector.start();

/** 启动摄像头 */
cameraManager.start();

/** 异步初始化 AI 检测器（加载模型较慢） */
aiDetector.init().then(() => {
  console.log("[App] AI 检测器初始化完成");
}).catch((err) => {
  console.error("[App] AI 检测器初始化失败:", err);
});

/** 启动 HTTP 服务 */
const eventStorage = new EventStorage(join(import.meta.dir, "../data/nvr.db"));
startServer(config.server.port, cameraManager, eventBus, annotator, eventStorage);

/** 自动记录事件到 SQLite */
const RECORDED_EVENTS = ["motion", "detect", "camera:online", "camera:offline"] as const;
for (const eventType of RECORDED_EVENTS) {
  eventBus.on(eventType, (payload) => {
    let detail: string | undefined;
    if (eventType === "motion") {
      detail = JSON.stringify({ ratio: (payload as { ratio: number }).ratio });
    } else if (eventType === "detect") {
      const p = payload as { detections: Array<{ label: string; score: number }> };
      detail = JSON.stringify({ detections: p.detections.map(d => ({ label: d.label, score: d.score })) });
    }
    eventStorage.insert(eventType, (payload as { cameraId: string }).cameraId, (payload as { timestamp: number }).timestamp ?? Date.now(), detail);
  });
}

/** 优雅退出 */
process.on("SIGINT", () => {
  console.log("\n[App] 正在关闭...");
  cameraManager.stop();
  eventBus.clear();
  process.exit(0);
});

/** 控制台日志：打印帧接收情况（每 5 秒一次统计） */
const frameCounts = new Map<string, number>();
eventBus.on("frame", ({ cameraId }) => {
  frameCounts.set(cameraId, (frameCounts.get(cameraId) ?? 0) + 1);
});
setInterval(() => {
  for (const [id, count] of frameCounts) {
    console.log(`[Frame] ${id}: ${count} 帧/5s`);
    frameCounts.set(id, 0);
  }
}, 5000);

/** 控制台日志：打印变动事件 */
eventBus.on("motion", ({ cameraId, ratio, timestamp }) => {
  const time = new Date(timestamp).toLocaleTimeString("zh-CN");
  console.log(`[Motion] ${time} | ${cameraId} | 变动比例 ${(ratio * 100).toFixed(1)}%`);
});

/** 控制台日志：打印 AI 检测事件 */
eventBus.on("detect", ({ cameraId, detections, timestamp }) => {
  const time = new Date(timestamp).toLocaleTimeString("zh-CN");
  const labels = detections.map((d) => `${d.label}(${(d.score * 100).toFixed(0)}%)`).join(", ");
  console.log(`[Detect] ${time} | ${cameraId} | ${detections.length} 个目标: ${labels}`);
});

/** 启动后保存前几帧截图到 data/snapshots 供验证 */
const SNAP_DIR = join(import.meta.dir, "../data/snapshots");
mkdirSync(SNAP_DIR, { recursive: true });
const snapCounts = new Map<string, number>();
const MAX_SNAPS = 3;
const unsub = eventBus.on("frame", ({ cameraId, data }) => {
  const count = (snapCounts.get(cameraId) ?? 0) + 1;
  snapCounts.set(cameraId, count);
  if (count > MAX_SNAPS) return;
  const filename = `${cameraId}_frame_${count}.webp`;
  /** JPEG → WebP 转码保存，体积更小 */
  sharp(data).webp({ quality: 80 }).toFile(join(SNAP_DIR, filename)).then(() => {
    console.log(`[Snapshot] 已保存: ${filename}`);
  });
  /** 所有摄像头都保存够了就取消订阅 */
  if (snapCounts.size >= config.cameras.length) {
    let allDone = true;
    for (const [, c] of snapCounts) {
      if (c < MAX_SNAPS) { allDone = false; break; }
    }
    if (allDone) unsub();
  }
});
