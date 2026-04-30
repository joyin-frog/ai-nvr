import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "@/config";
import { EventBus } from "@/event-bus";
import { CameraManager } from "@/camera/manager";
import { MotionDetector } from "@/detection/motion";
import { startServer } from "@/api";

/** 全局事件总线 */
const eventBus = new EventBus();

/** 加载配置 */
const config = loadConfig();
console.log(`[Config] 已加载配置，${config.cameras.length} 个摄像头`);

/** 摄像头管理器 */
const cameraManager = new CameraManager(config, eventBus);

/** 变动检测器 */
const motionDetector = new MotionDetector(config.motion, eventBus);

/** 启动变动检测 */
motionDetector.start();

/** 启动摄像头 */
cameraManager.start();

/** 启动 HTTP 服务 */
startServer(config.server.port, cameraManager, eventBus);

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

/** 启动后保存前几帧截图到 data/snapshots 供验证 */
const SNAP_DIR = join(import.meta.dir, "../data/snapshots");
mkdirSync(SNAP_DIR, { recursive: true });
const snapCounts = new Map<string, number>();
const MAX_SNAPS = 3;
const unsub = eventBus.on("frame", ({ cameraId, data }) => {
  const count = (snapCounts.get(cameraId) ?? 0) + 1;
  snapCounts.set(cameraId, count);
  if (count > MAX_SNAPS) return;
  const filename = `${cameraId}_frame_${count}.jpg`;
  writeFileSync(join(SNAP_DIR, filename), data);
  console.log(`[Snapshot] 已保存: ${filename} (${data.length} bytes)`);
  /** 所有摄像头都保存够了就取消订阅 */
  if (snapCounts.size >= config.cameras.length) {
    let allDone = true;
    for (const [, c] of snapCounts) {
      if (c < MAX_SNAPS) { allDone = false; break; }
    }
    if (allDone) unsub();
  }
});
