import { join } from "node:path";
import { loadConfig, watchConfig } from "@/config";
import { EventBus } from "@/event-bus";
import { CameraManager } from "@/camera/manager";
import { MotionDetector } from "@/detection/motion";
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
import { DetectRuleStorage } from "@/detect-rule/storage";
import { DetectRuleEngine } from "@/detect-rule/engine";
import { StateStorage } from "@/state/storage";
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

/** 全局未处理 Promise 拒绝日志（防止静默崩溃） */
process.on("unhandledRejection", (reason) => {
  console.error("[UnhandledRejection]", reason);
});
/**
 * 设置 Hugging Face 镜像（用于 CLIP 模型下载）
 */
process.env.HF_ENDPOINT = process.env.HF_ENDPOINT ?? "https://hf-mirror.com";

/** 全局事件总线 */
const eventBus = new EventBus();

/** 启动前异步清理残留 ffmpeg 进程（不阻塞事件循环） */
void (async () => {
  try {
    const pids = (await Bun.$`pgrep -f ffmpeg 2>/dev/null || true`.text()).trim();
    if (pids) {
      const list = pids.split("\n").filter(Boolean);
      console.log(`[App] 清理 ${list.length} 个残留 ffmpeg 进程: ${list.join(", ")}`);
      await Bun.$`kill -9 ${list.join(" ")} 2>/dev/null || true`.quiet();
    }
    const defunct = (await Bun.$`ps aux | grep -c '<defunct>' 2>/dev/null || echo 0`.text()).trim();
    const count = parseInt(defunct, 10);
    if (count > 10) {
      console.log(`[App] 检测到 ${count} 个僵尸进程，尝试清理`);
      await Bun.$`kill -CHLD 1 2>/dev/null || true`.quiet();
    }
  } catch {
    // ignore
  }
})();

/** 加载配置 */
const config = loadConfig();
console.log(`[Config] 已加载配置，${config.cameras.length} 个摄像头`);

/** 数据存储根目录 */
const dataDir = config.storage.dataDir;

/** 运行时配置（支持 API 热修改，检测器实时读取） */
const runtimeConfig = new RuntimeConfig(config);

/** 磁盘用量统计（SQLite 持久化增量追踪，启动时不扫描文件系统） */
const diskUsage = new DiskUsage(dataDir);
/** 启动后台磁盘空间刷新（每 60 秒异步查询一次，API 只读缓存） */
diskUsage.startBackgroundRefresh();

/** 存储文件系统封装（统一文件操作 + 自动增量统计 + 文件索引） */
const storageFs = new StorageFs(dataDir, diskUsage);

/** 录像器（通过 EventBus 接收帧，不单独拉 RTSP 流） */
const recorder = new MotionRecorder(join(dataDir, "recordings"), config.ffmpegPath, eventBus, runtimeConfig, storageFs);
/** 文件删除时自动清除录像列表缓存 */
storageFs.onDelete = (relativePath) => {
  if (relativePath.startsWith("recordings/")) recorder.invalidateListCache();
};
/** 注册摄像头友好名称（用于录像水印） */
for (const cam of config.cameras) {
  recorder.registerCameraName(cam.id, cam.friendlyName);
}
recorder.start().catch(err => console.error("[Recorder] 启动失败:", err));

const trackStorage = new TrackStorage(join(dataDir, "tracks"));
const trackLabelStorage = new TrackLabelStorage(join(dataDir, "track-labels.db"));
const trajectoryStorage = new TrackTrajectoryStorage(join(dataDir, "track-trajectory.db"));

/** CLIP 零样本分类服务（可选启用，为 VLM 检测结果补充语义标签） */
const clipService = new ClipService(config.ai.clip, join(dataDir, "models"));
if (config.ai.clip.candidates) {
  setCustomCandidates(config.ai.clip.candidates);
}

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


/** 告警快照存储（独立的目录，不监听 detect 事件） */
const alertSnapshotStorage = new SnapshotStorage(storageFs, "alert-snapshots", "alert-snapshots");

/** 告警存储与引擎 */
const alertStorage = new AlertStorage(join(dataDir, "alerts.db"));
const alertEngine = new AlertEngine(eventBus, alertStorage);
alertEngine.start();

/** 检测规则引擎 */
const detectRuleStorage = new DetectRuleStorage(join(dataDir, "detect-rules.db"));
const stateStorage = new StateStorage(join(dataDir, "state.db"));
const detectRuleEngine = new DetectRuleEngine(eventBus, detectRuleStorage, cameraManager, runtimeConfig, roiStorage, stateStorage);
detectRuleEngine.setRecorder(recorder);
detectRuleEngine.setFfmpegPath(config.ffmpegPath);
detectRuleEngine.setRefImagesDir(join(dataDir, "ref-images"));
detectRuleEngine.setTrackStores(trajectoryStorage, trackStorage);
detectRuleEngine.setSaveSnapshot((cameraId, timestamp, jpeg) => {
  alertSnapshotStorage.saveSnapshot(cameraId, timestamp, jpeg);
});
detectRuleEngine.start();


/** 目标活动档案收集器（追踪目标全生命周期，消失时 AI 摘要） */
import { TrackActivityCollector } from "@/ai/track-activity";
const trackActivityCollector = new TrackActivityCollector(eventBus, runtimeConfig);
trackActivityCollector.start();

/** 多模态 LLM 分析器（场景语义描述） */
const multimodalAnalyzer = new MultimodalAnalyzer(eventBus, runtimeConfig.get().ai.llm);
multimodalAnalyzer.setRecorder(recorder);
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
const thumbnailGenerator = new ThumbnailGenerator(join(dataDir, "thumbnails"), config.ffmpegPath, storageFs);

/** 事件存储（cleaner 和 server 都需要） */
const eventStorage = new EventStorage(join(dataDir, "nvr.db"));

/** 录像导出器 */
const exporter = new RecordingExporter(join(dataDir, "exports"), config.ffmpegPath, storageFs, eventStorage);

/** 统一存储清理管理器 */
const cleaner = new StorageCleaner(runtimeConfig, eventStorage, detectRuleStorage, thumbnailGenerator, exporter, diskUsage, recorder, trackStorage, alertSnapshotStorage, trajectoryStorage, trackLabelStorage);
cleaner.start();

/** AI 事件摘要器（定期用 LLM 汇总事件流） */
import { EventSummarizer } from "@/ai/event-summarizer";
const eventSummarizer = new EventSummarizer(eventBus, eventStorage, runtimeConfig);
if (runtimeConfig.get().ai.llm.enabled) {
  eventSummarizer.start();
}

/** AI 主动巡逻扫描器（定期扫描所有摄像头，生成全局态势感知） */
import { AiPatrolScanner } from "@/ai/patrol";
const patrolScanner = new AiPatrolScanner(eventBus, runtimeConfig, cameraManager, eventStorage);
patrolScanner.setRecorder(recorder);
if (runtimeConfig.get().ai.llm.enabled) {
  patrolScanner.start();
}

/** 录像 AI 摘要生成器（录像完成时用 LLM 生成摘要） */
import { RecordingSummarizer } from "@/ai/recording-summarizer";
const recordingSummarizer = new RecordingSummarizer(eventBus, eventStorage, runtimeConfig);
if (runtimeConfig.get().ai.llm.enabled) {
  recordingSummarizer.start();
}

/** 磁盘用量统计已在上方创建 */

/** PTZ 云台控制器 */
const ptzController = new PtzController();
/** 并行注册所有 PTZ 设备（避免串行等待） */
const ptzRegistrations = config.cameras
  .filter(cam => cam.ptz?.enabled)
  .map(cam => ptzController.register({
    cameraId: cam.id,
    driver: cam.ptz!.driver ?? "onvif",
    hostname: cam.ptz!.host,
    port: cam.ptz!.port,
    username: cam.ptz!.username,
    password: cam.ptz!.password,
    channel: cam.ptz!.channel ?? 1,
  }).then(() => {
    console.log(`[PTZ] ${cam.id} 已注册`);
  }).catch((err) => {
    console.error(`[PTZ] ${cam.id} 注册失败:`, err);
  }));
void Promise.allSettled(ptzRegistrations);

/** 启动 HTTP 服务 */
const monitor = new SystemMonitor(eventBus);
startServer(config.server.port, cameraManager, eventBus, eventStorage, recorder, monitor, runtimeConfig, roiStorage, alertStorage, thumbnailGenerator, cleaner, diskUsage, exporter, config.auth, ptzController, trackLabelStorage, trackStorage, preferencesStorage, crossLineStorage, storageFs, alertSnapshotStorage, trajectoryStorage, multimodalAnalyzer, clipService, detectRuleStorage, detectRuleEngine, stateStorage, patrolScanner);

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

/** 需要持久化到 SQLite 的事件类型（仅保留有查询价值的事件） */
const RECORDED_EVENTS = ["camera:online", "camera:offline", "detect:rule", "alert", "track:disappeared", "track:enter-zone", "track:leave-zone", "track:dwell", "track:line-cross", "track:loiter", "track:crowd", "llm:scene", "track:activity-summary", "state:changed"] as const;
for (const eventType of RECORDED_EVENTS) {
  eventBus.on(eventType, (payload) => {
    /** dwell 事件只在停留超过 30 秒时持久化（减少高频写入） */
    if (eventType === "track:dwell") {
      const p = payload as { dwellMs: number };
      if (p.dwellMs < 30000) return;
    }
    let detail: string | undefined;
    if (eventType === "alert") {
      const p = payload as { ruleName: string; detail: string };
      detail = JSON.stringify({ ruleName: p.ruleName, detail: p.detail });
    } else if (eventType === "llm:scene") {
      const p = payload as { description: string; trigger: string; inferMs: number };
      detail = JSON.stringify({ description: p.description, trigger: p.trigger, inferMs: p.inferMs });
    } else if (eventType === "state:changed") {
      const p = payload as { stateName: string; oldValue: string; newValue: string; source: string; notify: boolean };
      detail = JSON.stringify({ stateName: p.stateName, oldValue: p.oldValue, newValue: p.newValue, source: p.source, notify: p.notify });
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
      if (p.targetTrackId !== undefined) obj.targetTrackId = p.targetTrackId;
      if (p.targetLabel) obj.targetLabel = p.targetLabel;
      if (p.targetTrackName) obj.targetTrackName = p.targetTrackName;
      if (p.targetSemanticLabel) obj.targetSemanticLabel = p.targetSemanticLabel;
      if (p.distance !== undefined) obj.distance = p.distance;
      if (p.summary !== undefined) obj.summary = p.summary;
      if (p.lifespanMs !== undefined) obj.lifespanMs = p.lifespanMs;
      if (p.zoneCount !== undefined) obj.zoneCount = p.zoneCount;
      if (p.eventCount !== undefined) obj.eventCount = p.eventCount;
      if (p.count !== undefined) obj.count = p.count;
      if (p.avgDistance !== undefined) obj.avgDistance = p.avgDistance;
      if (Array.isArray(p.trackIds)) obj.trackIds = p.trackIds;
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

/** 优雅关闭函数 */
async function gracefulShutdown(signal: string): Promise<void> {
  console.log(`\n[App] 收到 ${signal}，正在关闭...`);
  cameraManager.stop();
  recorder.stop();
  trackActivityCollector.stop();
  multimodalAnalyzer.stop();
  eventSummarizer.stop();
  patrolScanner.stop();
  recordingSummarizer.stop();
  clipService.dispose();
  cleaner.stop();
  alertEngine.stop();
  detectRuleEngine.stop();
  eventStorage.close();
  roiStorage.close();
  crossLineStorage.close();
  alertStorage.close();
  detectRuleStorage.close();
  stateStorage.close();
  preferencesStorage.close();
  diskUsage.close();
  trajectoryStorage.close();
  trackLabelStorage.close();
  eventBus.clear();
  /** 给异步清理操作 500ms 完成（ffmpeg 进程终止、SQLite WAL 刷盘） */
  await new Promise<void>(r => setTimeout(r, 500));
  process.exit(0);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

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
/** fMP4 segment 帧率统计 */
const fmp4Counts = new Map<string, number>();
const fmp4Bytes = new Map<string, number>();
eventBus.on("fmp4:segment", ({ cameraId, moofData, mdatData }) => {
  fmp4Counts.set(cameraId, (fmp4Counts.get(cameraId) ?? 0) + 1);
  fmp4Bytes.set(cameraId, (fmp4Bytes.get(cameraId) ?? 0) + moofData.length + mdatData.length);
});
setInterval(() => {
  for (const [id, count] of frameCounts) {
    const fmp4Count = fmp4Counts.get(id) ?? 0;
    const bytes = fmp4Bytes.get(id) ?? 0;
    const kbPerSeg = fmp4Count > 0 ? (bytes / fmp4Count / 1024).toFixed(0) : "0";
    console.log(`[FPS] ${id}: JPEG=${count}/5s, fMP4=${fmp4Count}/5s (${kbPerSeg} KB/seg)`);
    frameCounts.set(id, 0);
    fmp4Counts.set(id, 0);
    fmp4Bytes.set(id, 0);
  }
}, 5000);

/** 定期强制 GC，避免 Bun/JSC 懒惰回收导致内存持续增长 */
setInterval(() => {
  if (typeof Bun !== "undefined" && Bun.gc) Bun.gc(true);
}, 5000);

/** 控制台日志：打印变动事件 */
eventBus.on("motion", ({ cameraId, ratio, timestamp }) => {
  const time = new Date(timestamp).toLocaleTimeString("zh-CN");
  console.log(`[Motion] ${time} | ${cameraId} | 变动比例 ${(ratio * 100).toFixed(1)}%`);
});

/** 控制台日志：打印告警事件 */
eventBus.on("alert", ({ ruleName, cameraId, timestamp, detail }) => {
  const time = new Date(timestamp).toLocaleTimeString("zh-CN");
  console.log(`[Alert] ${time} | ${cameraId} | ${ruleName}${detail ? ` | ${detail}` : ""}`);
});

