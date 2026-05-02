import { execSync } from "node:child_process";
import { join } from "node:path";
import { loadConfig, watchConfig } from "@/config";
import { EventBus } from "@/event-bus";
import { CameraManager } from "@/camera/manager";
import { MotionDetector } from "@/detection/motion";
import { AiDetector } from "@/ai/detector";
import { Annotator } from "@/ai/annotator";
import { startServer } from "@/api";
import { EventStorage } from "@/storage/events";
import { installLogBuffer } from "@/log-buffer";
import { MotionRecorder } from "@/storage/recorder";
import { SystemMonitor } from "@/monitor";
import { RuntimeConfig } from "@/runtime-config";
import { WebhookNotifier } from "@/notify/webhook";
import { DingTalkNotifier } from "@/notify/dingtalk";
import { EmailNotifier } from "@/notify/email";
import { SnapshotStorage } from "@/storage/snapshots";
import { RoiStorage } from "@/storage/roi";
import { AlertStorage } from "@/alert/storage";
import { AlertEngine } from "@/alert/engine";
import { ThumbnailGenerator } from "@/storage/thumbnails";
import { StorageCleaner } from "@/storage/cleaner";
import { DiskUsage } from "@/storage/disk-usage";
import { RecordingExporter } from "@/storage/export";
import { PtzController } from "@/ptz";
import { TrackLabelStorage } from "@/storage/track-labels";
import { TrackStorage } from "@/storage/tracks";
import { PreferencesStorage } from "@/storage/preferences";
import { CrossLineStorage } from "@/storage/cross-lines";
import { TrackTrajectoryStorage } from "@/storage/track-trajectory";
import { StorageFs } from "@/storage/storage-fs";
import { MultimodalAnalyzer } from "@/ai/multimodal-analyzer";
import { ClipService, setCustomCandidates } from "@/ai/clip-service";

/**
 * 安装内存日志缓冲区（拦截 console.log/warn/error）
 * 必须在其他模块使用 console 之前安装
 */
installLogBuffer();

/**
 * 设置 Hugging Face 镜像（国内网络加速模型下载）
 * 注意：HF_ENDPOINT 仅对 Python SDK 生效，JS 库需要设置 env.remoteHost（在 detector.ts 中处理）
 */
process.env.HF_ENDPOINT = process.env.HF_ENDPOINT ?? "https://hf-mirror.com";

/** 全局事件总线 */
const eventBus = new EventBus();

/** 启动前清理残留 ffmpeg 进程（包括僵尸进程） */
try {
  /** 清理活跃的 ffmpeg 进程 */
  const pids = execSync("pgrep -f ffmpeg || true", { encoding: "utf-8" }).trim();
  if (pids) {
    const list = pids.split("\n").filter(Boolean);
    console.log(`[App] 清理 ${list.length} 个残留 ffmpeg 进程: ${list.join(", ")}`);
    execSync(`kill -9 ${list.join(" ")} 2>/dev/null || true`, { timeout: 3000 });
  }
  /** 清理 bun --watch 留下的 ffmpeg 僵尸进程（通过 kill 父进程 PID 来回收） */
  const defunct = execSync("ps aux | grep -c '<defunct>' || echo 0", { encoding: "utf-8" }).trim();
  const count = parseInt(defunct, 10);
  if (count > 10) {
    console.log(`[App] 检测到 ${count} 个僵尸进程，尝试清理`);
    /** 向 init 进程发送信号回收僵尸（linux 会自动回收） */
    execSync("kill -CHLD 1 2>/dev/null || true", { timeout: 3000 });
  }
} catch {
  // ignore
}

/** 加载配置 */
const config = loadConfig();
console.log(`[Config] 已加载配置，${config.cameras.length} 个摄像头`);

/** 数据存储根目录 */
const dataDir = config.storage.dataDir;

/** 运行时配置（支持 API 热修改，检测器实时读取） */
const runtimeConfig = new RuntimeConfig(config);

/** 磁盘用量统计（SQLite 持久化增量追踪） */
const diskUsage = new DiskUsage(dataDir);
diskUsage.ensureCalibrated();

/** 存储文件系统封装（统一文件操作 + 自动增量统计） */
const storageFs = new StorageFs(dataDir, diskUsage);

/** 录像器（通过 EventBus 接收帧，不单独拉 RTSP 流） */
const recorder = new MotionRecorder(join(dataDir, "recordings"), config.ffmpegPath, eventBus, runtimeConfig, storageFs);
/** 注册摄像头友好名称（用于录像水印） */
for (const cam of config.cameras) {
  recorder.registerCameraName(cam.id, cam.friendlyName);
}
recorder.start();

/** AI 检测器（使用 RuntimeConfig，支持 API 热修改置信度/最大检测数） */
const annotator = new Annotator();
const trackStorage = new TrackStorage(join(dataDir, "tracks"));
const trackLabelStorage = new TrackLabelStorage(join(dataDir, "track-labels.db"));
const trajectoryStorage = new TrackTrajectoryStorage(join(dataDir, "track-trajectory.db"));

/** CLIP 零样本分类服务（可选启用） */
const clipService = new ClipService(config.ai.clip, join(dataDir, "models"));
/** 启动时应用配置中的自定义候选标签 */
if (config.ai.clip.candidates) {
  setCustomCandidates(config.ai.clip.candidates);
}

const aiDetector = new AiDetector(runtimeConfig, eventBus, annotator, join(dataDir, "models"), trackStorage, trackLabelStorage, trajectoryStorage, clipService);

/** 摄像头管理器（主码流预览/检测 + 主码流注册给录像器） */
const cameraManager = new CameraManager(config, eventBus, recorder, runtimeConfig);

/** ROI 检测区域存储（MotionDetector 需要） */
const roiStorage = new RoiStorage(join(dataDir, "roi.db"));

/** 越线检测线段存储 */
const crossLineStorage = new CrossLineStorage(join(dataDir, "cross-lines.db"));

/** 变动检测器（使用 RuntimeConfig + ROI 区域过滤） */
const motionDetector = new MotionDetector(runtimeConfig, eventBus, roiStorage);

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

/** 异步初始化 CLIP 零样本分类（可选，默认禁用） */
if (config.ai.clip.enabled) {
  clipService.init().then(() => {
    console.log("[App] CLIP 零样本分类初始化完成");
  }).catch((err) => {
    console.error("[App] CLIP 初始化失败:", err);
  });
}

/** Webhook 通知（事件推送到外部 URL） */
const webhookNotifier = new WebhookNotifier(runtimeConfig, eventBus);
webhookNotifier.start();

/** 钉钉机器人通知 */
const dingtalkNotifier = new DingTalkNotifier(runtimeConfig, eventBus);
dingtalkNotifier.start();

/** 邮件告警通知 */
const emailNotifier = new EmailNotifier(runtimeConfig, eventBus);
emailNotifier.start();

/** 检测快照存储（保存标注图到磁盘） */
const snapshotStorage = new SnapshotStorage(join(dataDir, "detection-snapshots"), eventBus);
snapshotStorage.start();

/** 告警快照存储（独立的目录，不监听 detect 事件） */
const alertSnapshotStorage = new SnapshotStorage(join(dataDir, "alert-snapshots"), eventBus);

/** 告警存储与引擎 */
const alertStorage = new AlertStorage(join(dataDir, "alerts.db"));
const alertEngine = new AlertEngine(eventBus, alertStorage, trackLabelStorage, roiStorage, annotator);
alertEngine.setSaveAlertSnapshot((cameraId, timestamp, jpeg) => {
  alertSnapshotStorage.saveSnapshot(cameraId, timestamp, jpeg);
});
alertEngine.start();

/** 行为分析器（区域进入/离开/停留/越线语义事件） */
import { BehaviorAnalyzer } from "@/ai/behavior";
const behaviorAnalyzer = new BehaviorAnalyzer(eventBus, roiStorage, crossLineStorage, runtimeConfig);
behaviorAnalyzer.start();

/** 多模态 LLM 分析器（场景语义描述） */
const multimodalAnalyzer = new MultimodalAnalyzer(eventBus, runtimeConfig.get().ai.llm);
if (runtimeConfig.get().ai.llm.enabled) {
  multimodalAnalyzer.start();
}

/** 用户偏好设置存储 */
const preferencesStorage = new PreferencesStorage(join(dataDir, "preferences.db"));

/** 从 preferences 恢复 CLIP 自定义候选标签（覆盖 YAML 配置） */
{
  const saved = preferencesStorage.get("clip-candidates");
  if (saved) {
    const candidates = JSON.parse(saved.value) as Record<string, string[]>;
    setCustomCandidates(candidates);
    console.log(`[App] 已恢复 ${Object.keys(candidates).length} 个 CLIP 自定义候选标签`);
  }
}

/** 录像缩略图生成器 */
const thumbnailGenerator = new ThumbnailGenerator(join(dataDir, "thumbnails"), config.ffmpegPath);

/** 事件存储（cleaner 和 server 都需要） */
const eventStorage = new EventStorage(join(dataDir, "nvr.db"));

/** 录像导出器 */
const exporter = new RecordingExporter(join(dataDir, "exports"), config.ffmpegPath);

/** 统一存储清理管理器 */
const cleaner = new StorageCleaner(runtimeConfig, eventStorage, alertStorage, snapshotStorage, thumbnailGenerator, exporter, diskUsage, recorder, trackStorage, alertSnapshotStorage, trajectoryStorage, trackLabelStorage);
cleaner.start();

/** 磁盘用量统计已在上方创建 */

/** PTZ 云台控制器 */
const ptzController = new PtzController();
for (const cam of config.cameras) {
  if (cam.ptz?.enabled) {
    ptzController.register({
      cameraId: cam.id,
      hostname: cam.ptz.host,
      port: cam.ptz.port,
      username: cam.ptz.username,
      password: cam.ptz.password,
    }).then(() => {
      console.log(`[PTZ] ${cam.id} 已注册`);
    }).catch((err) => {
      console.error(`[PTZ] ${cam.id} 注册失败:`, err);
    });
  }
}

/** 启动 HTTP 服务 */
const monitor = new SystemMonitor(eventBus);
startServer(config.server.port, cameraManager, eventBus, annotator, eventStorage, recorder, monitor, runtimeConfig, snapshotStorage, roiStorage, alertStorage, thumbnailGenerator, cleaner, diskUsage, exporter, aiDetector, config.auth, ptzController, trackLabelStorage, trackStorage, preferencesStorage, crossLineStorage, storageFs, alertSnapshotStorage, trajectoryStorage, multimodalAnalyzer, clipService);

/** 自动记录事件到 SQLite */
/** 事件收集缓冲区（同一微任务周期内的事件批量写入） */
const pendingEvents: Array<{ type: string; cameraId: string; timestamp: number; detail?: string }> = [];
let eventFlushTimer: ReturnType<typeof setImmediate> | null = null;

function flushPendingEvents() {
  eventFlushTimer = null;
  if (pendingEvents.length === 0) return;
  const batch = pendingEvents.splice(0);
  eventStorage.insertMany(batch);
}

const RECORDED_EVENTS = ["motion", "detect", "camera:online", "camera:offline", "alert", "track:appeared", "track:disappeared", "track:enter-zone", "track:leave-zone", "track:dwell", "track:speed", "track:line-cross", "track:loiter", "llm:scene"] as const;
for (const eventType of RECORDED_EVENTS) {
  eventBus.on(eventType, (payload) => {
    /** 0 目标或重复检测结果不记录事件 */
    if (eventType === "detect") {
      const p = payload as { detections: unknown[]; changed?: boolean };
      if (p.detections.length === 0 || p.changed === false) return;
    }
    /** dwell 事件只在停留超过 30 秒时持久化（减少高频写入） */
    if (eventType === "track:dwell") {
      const p = payload as { dwellMs: number };
      if (p.dwellMs < 30000) return;
    }
    let detail: string | undefined;
    if (eventType === "motion") {
      detail = JSON.stringify({ ratio: (payload as { ratio: number }).ratio });
    } else if (eventType === "detect") {
      const p = payload as { detections: Array<{ label: string; score: number; box?: { xmin: number; ymin: number; xmax: number; ymax: number }; trackId?: number; trackName?: string; semanticLabel?: string }> };
      detail = JSON.stringify({ detections: p.detections.map(d => ({ label: d.label, score: d.score, box: d.box, trackId: d.trackId, trackName: d.trackName, semanticLabel: d.semanticLabel })) });
    } else if (eventType === "alert") {
      const p = payload as { ruleName: string; detail: string };
      detail = JSON.stringify({ ruleName: p.ruleName, detail: p.detail });
    } else if (eventType === "llm:scene") {
      const p = payload as { description: string; trigger: string; inferMs: number };
      detail = JSON.stringify({ description: p.description, trigger: p.trigger, inferMs: p.inferMs });
    } else if (eventType.startsWith("track:")) {
      const p = payload as Record<string, unknown>;
      const obj: Record<string, unknown> = { trackId: p.trackId, label: p.label };
      if (p.trackName) obj.trackName = p.trackName;
      if (p.semanticLabel) obj.semanticLabel = p.semanticLabel;
      if (p.zoneId !== undefined) obj.zoneId = p.zoneId;
      if (p.zoneName) obj.zoneName = p.zoneName;
      if (p.dwellMs !== undefined) obj.dwellMs = p.dwellMs;
      if (p.score !== undefined) obj.score = p.score;
      if (p.speed !== undefined) obj.speed = p.speed;
      detail = JSON.stringify(obj);
    }
    pendingEvents.push({ type: eventType, cameraId: (payload as { cameraId: string }).cameraId, timestamp: (payload as { timestamp: number }).timestamp ?? Date.now(), detail });
    /** 延迟到微任务结束时批量写入 */
    if (!eventFlushTimer) {
      eventFlushTimer = setImmediate(flushPendingEvents);
    }
  });
}

/** 配置热重载：监听 YAML 变更，动态增删摄像头 */
watchConfig(undefined, (newConfig) => {
  cameraManager.reloadConfig(newConfig);
  console.log(`[Config] 热重载完成，${newConfig.cameras.length} 个摄像头`);
});

/** 优雅退出 */
process.on("SIGINT", () => {
  console.log("\n[App] 正在关闭...");
  recorder.stop();
  cameraManager.stop();
  behaviorAnalyzer.stop();
  multimodalAnalyzer.stop();
  clipService.dispose();
  aiDetector.dispose();
  cleaner.stop();
  eventStorage.close();
  roiStorage.close();
  crossLineStorage.close();
  alertStorage.close();
  preferencesStorage.close();
  diskUsage.close();
  trajectoryStorage.close();
  eventBus.clear();
  process.exit(0);
});

/** bun --watch 重启时不发 SIGINT，用 beforeExit 清理 ffmpeg 子进程 */
process.on("beforeExit", () => {
  cameraManager.stop();
  recorder.stop();
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
  const labels = detections.map((d) => `${d.label}#${(d as { trackId?: number }).trackId ?? "?"}(${(d.score * 100).toFixed(0)}%)`).join(", ");
  console.log(`[Detect] ${time} | ${cameraId} | ${detections.length} 个目标: ${labels}`);
});

/** 控制台日志：打印告警事件 */
eventBus.on("alert", ({ ruleName, cameraId, timestamp, detail }) => {
  const time = new Date(timestamp).toLocaleTimeString("zh-CN");
  console.log(`[Alert] ${time} | ${cameraId} | ${ruleName}${detail ? ` | ${detail}` : ""}`);
});

