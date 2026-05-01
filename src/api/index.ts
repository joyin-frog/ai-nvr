import { type CameraManager } from "@/camera/manager";
import { type EventBus, type EventName } from "@/event-bus";
import { type Annotator } from "@/ai/annotator";
import { type EventStorage } from "@/storage/events";
import { type MotionRecorder } from "@/storage/recorder";
import { type SystemMonitor } from "@/monitor";
import { type RuntimeConfig } from "@/runtime-config";
import { type SnapshotStorage } from "@/storage/snapshots";
import { type RoiStorage } from "@/storage/roi";
import { type AlertStorage } from "@/alert/storage";
import { type ThumbnailGenerator } from "@/storage/thumbnails";
import { type StorageCleaner } from "@/storage/cleaner";
import { type DiskUsage } from "@/storage/disk-usage";
import { type RecordingExporter } from "@/storage/export";
import { type AiDetector } from "@/ai/detector";
import { type PtzController } from "@/ptz";
import { addCameraToConfig, removeCameraFromConfig, updateCameraInConfig, loadConfig, type AuthConfig } from "@/config";
import { checkAuth } from "@/auth";
import { existsSync, statSync, realpathSync, unlinkSync } from "node:fs";
import { resolve, extname } from "node:path";
import { spawnSync } from "node:child_process";

/** WebSocket 客户端集合 */
const wsClients = new Set<import("bun").ServerWebSocket>();

/** CORS 响应头 */
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

/** 为 Response 添加 CORS 头 */
function corsify(res: Response): Response {
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    res.headers.set(k, v);
  }
  return res;
}

/** 要推送给前端的事件列表 */
const PUSH_EVENTS: EventName[] = ["motion", "detect", "camera:online", "camera:offline", "camera:lowfps", "alert"];

/**
 * 启动 HTTP + WebSocket 服务
 */
export function startServer(
  port: number,
  cameraManager: CameraManager,
  eventBus: EventBus,
  annotator: Annotator,
  eventStorage: EventStorage,
  recorder: MotionRecorder,
  monitor: SystemMonitor,
  runtimeConfig: RuntimeConfig,
  snapshotStorage: SnapshotStorage,
  roiStorage: RoiStorage,
  alertStorage: AlertStorage,
  thumbnailGenerator: ThumbnailGenerator,
  cleaner: StorageCleaner,
  diskUsage: DiskUsage,
  exporter: RecordingExporter,
  aiDetector: AiDetector,
  authConfig: AuthConfig,
  ptzController: PtzController,
  trackLabelStorage: import("@/storage/track-labels").TrackLabelStorage,
  trackStorage: import("@/storage/tracks").TrackStorage,
): void {
  /** 处理 HTTP 请求（不含 CORS 和 WebSocket 逻辑） */
  async function handleRequest(req: Request): Promise<Response | undefined> {
    const url = new URL(req.url);

    if (url.pathname === "/api/auth/check") {
      return Response.json({ enabled: !!authConfig.token });
    }

    /** 登录端点：验证 token */
    if (url.pathname === "/api/auth/login" && req.method === "POST") {
        return req.json().then((body: unknown) => {
          const obj = body as Record<string, unknown>;
          const token = obj.token as string | undefined;
          if (!token || token !== authConfig.token) {
            return new Response("Invalid token", { status: 401 });
          }
          return Response.json({ ok: true });
        }).catch(() => new Response("Invalid JSON", { status: 400 }));
      }

      /** API 认证检查 */
      if (!checkAuth(authConfig, req)) {
        return new Response("Unauthorized", { status: 401 });
      }

      /** REST API */
      if (url.pathname === "/api") {
        return Response.json({
          name: "JK NVR",
          status: "running",
          cameras: cameraManager.getStatus().length,
          endpoints: [
            "GET /api/cameras",
            "POST /api/cameras",
            "PATCH /api/cameras/:id",
            "DELETE /api/cameras/:id",
            "GET /api/health",
            "GET /api/settings",
            "PATCH /api/settings",
            "GET /api/events/history?type=&cameraId=&since=&until=&limit=&offset=",
            "GET /api/recordings?cameraId=",
            "GET /api/recordings/:cameraId/:filename",
            "GET /api/detection/annotated/:cameraId",
            "WS  /api/events",
          ],
        });
      }

      if (url.pathname === "/api/cameras" && req.method === "GET") {
        const cameras = cameraManager.getStatus();
        /** 添加录像状态 */
        const recStates = recorder.getRecordingStates();
        const recMap = new Map(recStates.map(r => [r.cameraId, r]));
        const enriched = cameras.map((c: Record<string, unknown>) => {
          const rs = recMap.get(c.id as string);
          return { ...c, recording: rs?.recording ?? false, recordingStart: rs?.startTime ?? 0 };
        });
        return Response.json(enriched);
      }

      /** 添加摄像头 */
      if (url.pathname === "/api/cameras" && req.method === "POST") {
        return req.json().then((body: unknown) => {
          const obj = body as Record<string, unknown>;
          const id = obj.id as string | undefined;
          const friendlyName = obj.friendlyName as string | undefined;
          const hdUrl = obj.hdUrl as string | undefined;
          const sdUrl = obj.sdUrl as string | undefined;
          if (!id || !friendlyName || !hdUrl || !sdUrl) {
            return new Response("Missing required fields: id, friendlyName, hdUrl, sdUrl", { status: 400 });
          }
          addCameraToConfig({ id, friendlyName, hdUrl, sdUrl, detectFps: obj.detectFps as number | undefined, group: obj.group as string | undefined });
          /** 触发配置热重载 */
          const newConfig = loadConfig();
          cameraManager.reloadConfig(newConfig);
          return Response.json({ ok: true, cameraId: id });
        }).catch(() => new Response("Invalid JSON", { status: 400 }));
      }

      /** 测试 RTSP 连接 */
      if (url.pathname === "/api/cameras/test" && req.method === "POST") {
        return req.json().then((body: unknown) => {
          const obj = body as Record<string, unknown>;
          const rtspUrl = obj.url as string | undefined;
          if (!rtspUrl) return new Response("Missing url", { status: 400 });
          const ffmpegPath = loadConfig().ffmpegPath;
          const result = spawnSync(ffmpegPath, [
            "-rtsp_transport", "tcp",
            "-i", rtspUrl,
            "-frames:v", "1",
            "-f", "null",
            "-",
          ], { timeout: 8000, stdio: "pipe" });
          const ok = result.status === 0;
          const stderr = result.stderr?.toString() ?? "";
          const match = stderr.match(/Video: ([^\n]+)/);
          const videoInfo = match ? match[1] : undefined;
          return Response.json({ ok, videoInfo, error: ok ? undefined : stderr.slice(-200) });
        }).catch(() => new Response("Invalid JSON", { status: 400 }));
      }

      /** 更新 / 删除摄像头 */
      const cameraByIdMatch = url.pathname.match(/^\/api\/cameras\/([^/]+)$/);
      if (cameraByIdMatch) {
        const cameraId = cameraByIdMatch[1]!;

        if (req.method === "PATCH") {
          return req.json().then((body: unknown) => {
            const obj = body as Record<string, unknown>;
            updateCameraInConfig(cameraId, {
              friendlyName: obj.friendlyName as string | undefined,
              hdUrl: obj.hdUrl as string | undefined,
              sdUrl: obj.sdUrl as string | undefined,
              group: obj.group as string | undefined,
            });
            const newConfig = loadConfig();
            cameraManager.reloadConfig(newConfig);
            return Response.json({ ok: true });
          }).catch(() => new Response("Invalid JSON", { status: 400 }));
        }

        if (req.method === "DELETE") {
          removeCameraFromConfig(cameraId);
          const newConfig = loadConfig();
          cameraManager.reloadConfig(newConfig);
          return Response.json({ ok: true });
        }
      }

      /** 系统健康检查 + 性能指标 */
      if (url.pathname === "/api/health") {
        const cameraIds = cameraManager.getStatus().map(c => c.id);
        return Response.json({
          ...monitor.getMetrics(cameraIds),
          storage: diskUsage.getInfo(),
        });
      }

      /** 获取运行时设置 */
      if (url.pathname === "/api/settings" && req.method === "GET") {
        return Response.json(runtimeConfig.get());
      }

      /** 更新运行时设置 */
      if (url.pathname === "/api/settings" && req.method === "PATCH") {
        return req.json().then((body: unknown) => {
          const oldMode = runtimeConfig.get().recording.mode;
          const updated = runtimeConfig.patchFromJSON(body);
          /** 录像模式变更时通知 recorder */
          if (updated.recording.mode !== oldMode) {
            recorder.reloadMode();
          }
          return Response.json(updated);
        }).catch(() => new Response("Invalid JSON", { status: 400 }));
      }

      /** 查询事件历史 */
      if (url.pathname === "/api/events/history") {
        const queryOpts = {
          type: url.searchParams.get("type") ?? undefined,
          cameraId: url.searchParams.get("cameraId") ?? undefined,
          since: url.searchParams.has("since") ? Number(url.searchParams.get("since")) : undefined,
          until: url.searchParams.has("until") ? Number(url.searchParams.get("until")) : undefined,
          limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 100,
          offset: url.searchParams.has("offset") ? Number(url.searchParams.get("offset")) : 0,
          search: url.searchParams.get("search") ?? undefined,
          starred: url.searchParams.get("starred") === "true" ? true : undefined,
        };
        const rawEvents = eventStorage.query(queryOpts);
        const total = eventStorage.count({
          type: queryOpts.type,
          cameraId: queryOpts.cameraId,
          since: queryOpts.since,
          until: queryOpts.until,
          search: queryOpts.search,
          starred: queryOpts.starred,
        });
        /** 给 detect 事件关联快照 URL 和检测结果 */
        const events = rawEvents.map(ev => {
          if (ev.type !== "detect") return ev;
          const snapPath = snapshotStorage.findSnapshotPath(ev.camera_id, ev.timestamp);
          if (!snapPath) return ev;
          const meta = snapshotStorage.getSnapshotMeta(snapPath);
          return {
            ...ev,
            snapshotUrl: `/api/snapshots/${snapPath}`,
            snapshotDetections: meta?.detections ?? null,
          };
        });
        return Response.json({ events, total });
      }

      /** 事件统计 */
      if (url.pathname === "/api/events/stats") {
        const since = url.searchParams.has("since") ? Number(url.searchParams.get("since")) : undefined;
        const until = url.searchParams.has("until") ? Number(url.searchParams.get("until")) : undefined;
        const opts = { since, until };
        return Response.json({
          byType: eventStorage.countByType(opts),
          byHour: eventStorage.countByHour(opts),
          byCamera: eventStorage.countByCamera(opts),
          byLabel: eventStorage.countByDetectionLabel(opts),
        });
      }

      /** 切换事件收藏状态 */
      const eventStarMatch = url.pathname.match(/^\/api\/events\/(\d+)\/star$/);
      if (eventStarMatch && req.method === "POST") {
        const id = Number(eventStarMatch[1]);
        const starred = eventStorage.toggleStar(id);
        return Response.json({ id, starred });
      }

      /** MJPEG 实时视频流：multipart/x-mixed-replace，浏览器 <img> 直接消费 */
      const mjpegMatch = url.pathname.match(/^\/api\/stream\/(.+)$/);
      if (mjpegMatch) {
        const cameraId = mjpegMatch[1]!;
        const frame = cameraManager.getLatestFrame(cameraId);
        /** 即使没有帧也启动流，等帧到达后推送（避免上线瞬间 404） */

        const boundary = "--nvrboundary";
        /** 空闲超时：30 秒无帧则关闭流，让客户端重连 */
        const IDLE_TIMEOUT = 30_000;

        let unsubscribe: (() => void) | null = null;
        let offlineUnsub: (() => void) | null = null;
        let idleTimer: ReturnType<typeof setTimeout> | null = null;

        const stream = new ReadableStream({
          start(controller) {
            let streamFrames = 0;
            let lastStreamLog = Date.now();

            /** 重置空闲计时器 */
            function resetIdle() {
              if (idleTimer) clearTimeout(idleTimer);
              idleTimer = setTimeout(() => {
                console.log(`[MJPEG][${cameraId}] 空闲超时，关闭流`);
                cleanup();
                try { controller.close(); } catch { /* */ }
              }, IDLE_TIMEOUT);
            }

            function cleanup() {
              if (unsubscribe) { unsubscribe(); unsubscribe = null; }
              if (offlineUnsub) { offlineUnsub(); offlineUnsub = null; }
              if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
            }

            unsubscribe = eventBus.on("frame", (payload) => {
              if (payload.cameraId !== cameraId) return;
              resetIdle();
              streamFrames++;

              try {
                const header = `${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${payload.data.length}\r\n\r\n`;
                controller.enqueue(new TextEncoder().encode(header));
                controller.enqueue(payload.data);
                controller.enqueue(new TextEncoder().encode("\r\n"));
                if (Date.now() - lastStreamLog >= 10000) {
                  console.log(`[Perf][MJPEG][${cameraId}] ${streamFrames}帧/10s`);
                  streamFrames = 0;
                  lastStreamLog = Date.now();
                }
              } catch {
                cleanup();
              }
            });

            /** 摄像头离线时立即关闭流 */
            offlineUnsub = eventBus.on("camera:offline", (payload) => {
              if (payload.cameraId !== cameraId) return;
              console.log(`[MJPEG][${cameraId}] 摄像头离线，关闭流`);
              cleanup();
              try { controller.close(); } catch { /* */ }
            });

            /** 立即发送当前帧（如果有） */
            if (frame) {
              const initHeader = `${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`;
              controller.enqueue(new TextEncoder().encode(initHeader));
              controller.enqueue(frame);
              controller.enqueue(new TextEncoder().encode("\r\n"));
            }
            resetIdle();
          },
          cancel() {
            if (unsubscribe) { unsubscribe(); unsubscribe = null; }
            if (offlineUnsub) { offlineUnsub(); offlineUnsub = null; }
            if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": `multipart/x-mixed-replace; boundary=${boundary}`,
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Connection": "keep-alive",
            ...CORS_HEADERS,
          },
        });
      }

      /** 获取摄像头最新帧（实时视频用，已预压缩） */
      const snapshotMatch = url.pathname.match(/^\/api\/snapshot\/(.+)$/);
      if (snapshotMatch) {
        const cameraId = snapshotMatch[1]!;
        const isHd = url.searchParams.get("quality") === "hd";
        if (isHd) {
          /** 从主码流拉取高清帧 */
          const cam = loadConfig().cameras.find(c => c.id === cameraId);
          if (!cam) return new Response("Camera not found", { status: 404 });
          const ffmpegPath = loadConfig().ffmpegPath;
          const result = spawnSync(ffmpegPath, [
            "-rtsp_transport", "tcp",
            "-i", cam.stream.hd,
            "-frames:v", "1",
            "-f", "image2pipe",
            "-vcodec", "mjpeg",
            "-q:v", "2",
            "-an",
            "pipe:1",
          ], { timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
          if (result.error || !result.stdout || result.stdout.length < 100) {
            return new Response("HD capture failed", { status: 504 });
          }
          return new Response(result.stdout, {
            headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-cache" },
          });
        }
        const frame = cameraManager.getLatestFrame(cameraId);
        if (!frame) return new Response("No frame", { status: 404 });
        return new Response(frame, {
          headers: {
            "Content-Type": "image/jpeg",
            "Cache-Control": "no-cache, no-store",
          },
        });
      }

      /** 录像列表 */
      if (url.pathname === "/api/recordings") {
        const cameraId = url.searchParams.get("cameraId") ?? undefined;
        const since = url.searchParams.has("since") ? Number(url.searchParams.get("since")) : undefined;
        const until = url.searchParams.has("until") ? Number(url.searchParams.get("until")) : undefined;
        return Response.json(recorder.listRecordings(cameraId, since, until));
      }

      /** 录像文件播放 */
      const recordingMatch = url.pathname.match(/^\/api\/recordings\/([^/]+)\/(.+\.mp4)$/);
      if (recordingMatch) {
        const camId = recordingMatch[1]!;
        const filename = recordingMatch[2]!;
        const filePath = recorder.getRecordingPath(`${camId}/${filename}`);
        if (!existsSync(filePath)) return new Response("Not Found", { status: 404 });
        /** 防止路径遍历：确保解析后的路径仍在录像目录内 */
        const storageRoot = realpathSync(recorder.getRecordingPath("."));
        const resolved = realpathSync(filePath);
        if (!resolved.startsWith(storageRoot)) return new Response("Forbidden", { status: 403 });
        const stat = statSync(filePath);
        const file = Bun.file(filePath);
        return new Response(file, {
          headers: {
            "Content-Type": "video/mp4",
            "Content-Length": String(stat.size),
            "Accept-Ranges": "bytes",
          },
        });
      }

      /** 删除录像文件 */
      if (recordingMatch && req.method === "DELETE") {
        const camId = recordingMatch[1]!;
        const filename = recordingMatch[2]!;
        const filePath = recorder.getRecordingPath(`${camId}/${filename}`);
        if (!existsSync(filePath)) return new Response("Not Found", { status: 404 });
        const storageRoot = realpathSync(recorder.getRecordingPath("."));
        const resolved = realpathSync(filePath);
        if (!resolved.startsWith(storageRoot)) return new Response("Forbidden", { status: 403 });
        unlinkSync(resolved);
        return Response.json({ ok: true });
      }

      /** 获取标注后的图片（按需生成） */
      const annotatedMatch = url.pathname.match(/^\/api\/detection\/annotated\/(.+)$/);
      if (annotatedMatch) {
        const cameraId = annotatedMatch[1]!;
        const image = await annotator.generateAnnotated(cameraId);
        if (!image) return new Response("No annotated image", { status: 404 });
        return new Response(image, {
          headers: { "Content-Type": "image/jpeg" },
        });
      }

      /** 录像缩略图 */
      const thumbMatch = url.pathname.match(/^\/api\/recordings\/thumb$/);
      if (thumbMatch && req.method === "GET") {
        const videoRelPath = url.searchParams.get("file");
        const timeSec = url.searchParams.has("time") ? Number(url.searchParams.get("time")) : 0;
        if (!videoRelPath) return new Response("Missing file param", { status: 400 });

        const videoPath = recorder.getRecordingPath(videoRelPath);
        if (!existsSync(videoPath)) return new Response("Not Found", { status: 404 });

        /** 防止路径遍历 */
        const storageRoot = realpathSync(recorder.getRecordingPath("."));
        const resolved = realpathSync(videoPath);
        if (!resolved.startsWith(storageRoot)) return new Response("Forbidden", { status: 403 });

        const thumbPath = thumbnailGenerator.getOrCreate(resolved, timeSec);
        if (!thumbPath) return new Response("Thumbnail generation failed", { status: 500 });

        const file = Bun.file(thumbPath);
        return new Response(file, {
          headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" },
        });
      }

      /** 批量预生成缩略图 */
      if (url.pathname === "/api/recordings/thumb-preload" && req.method === "POST") {
        return req.json().then((body: unknown) => {
          const obj = body as Record<string, unknown>
          const files = obj.files as Array<{ filename: string; durationSec: number }> | undefined
          if (!files || !Array.isArray(files)) return new Response("Invalid body", { status: 400 })

          const storageRoot = realpathSync(recorder.getRecordingPath("."))
          const tasks: Array<{ path: string; durationSec: number }> = []
          for (const f of files) {
            const videoPath = recorder.getRecordingPath(f.filename)
            if (!existsSync(videoPath)) continue
            const resolved = realpathSync(videoPath)
            if (!resolved.startsWith(storageRoot)) continue
            tasks.push({ path: resolved, durationSec: f.durationSec })
          }
          thumbnailGenerator.pregenerate(tasks)
          return Response.json({ queued: tasks.length })
        })
      }

      /** 录像导出：裁剪视频片段 */
      if (url.pathname === "/api/recordings/export" && req.method === "POST") {
        return req.json().then((body: unknown) => {
          const obj = body as Record<string, unknown>;
          const file = obj.file as string | undefined;
          const startSec = obj.startSec as number | undefined;
          const endSec = obj.endSec as number | undefined;
          const cameraId = obj.cameraId as string | undefined;
          if (!file || startSec === undefined || endSec === undefined) {
            return new Response("Missing file, startSec, endSec", { status: 400 });
          }

          const videoPath = recorder.getRecordingPath(file);
          if (!existsSync(videoPath)) return new Response("Not Found", { status: 404 });

          /** 防止路径遍历 */
          const storageRoot = realpathSync(recorder.getRecordingPath("."));
          const resolved = realpathSync(videoPath);
          if (!resolved.startsWith(storageRoot)) return new Response("Forbidden", { status: 403 });

          const result = exporter.export(resolved, startSec, endSec, cameraId ?? "unknown");
          if (!result) return new Response("Export failed", { status: 500 });

          const exportFilename = result.filePath.split("/").pop()!;
          return Response.json({ filename: exportFilename, size: result.size });
        }).catch(() => new Response("Invalid JSON", { status: 400 }));
      }

      /** 录像合并导出：合并多个录像文件 */
      if (url.pathname === "/api/recordings/merge" && req.method === "POST") {
        return req.json().then((body: unknown) => {
          const obj = body as Record<string, unknown>;
          const files = obj.files as string[] | undefined;
          const cameraId = obj.cameraId as string | undefined;
          if (!files || !Array.isArray(files) || files.length === 0) {
            return new Response("Missing files array", { status: 400 });
          }

          /** 防止路径遍历：验证所有文件 */
          const storageRoot = realpathSync(recorder.getRecordingPath("."));
          const resolvedPaths: string[] = [];
          for (const relPath of files) {
            const videoPath = recorder.getRecordingPath(relPath);
            if (!existsSync(videoPath)) return new Response(`Not Found: ${relPath}`, { status: 404 });
            const resolved = realpathSync(videoPath);
            if (!resolved.startsWith(storageRoot)) return new Response("Forbidden", { status: 403 });
            resolvedPaths.push(resolved);
          }

          const result = exporter.merge(resolvedPaths, cameraId ?? "unknown");
          if (!result) return new Response("Merge failed", { status: 500 });

          const exportFilename = result.filePath.split("/").pop()!;
          return Response.json({ filename: exportFilename, size: result.size });
        }).catch(() => new Response("Invalid JSON", { status: 400 }));
      }

      /** GIF 导出：将视频片段转为 GIF 动图 */
      if (url.pathname === "/api/recordings/gif" && req.method === "POST") {
        return req.json().then((body: unknown) => {
          const obj = body as Record<string, unknown>;
          const file = obj.file as string | undefined;
          const startSec = obj.startSec as number | undefined;
          const endSec = obj.endSec as number | undefined;
          const cameraId = obj.cameraId as string | undefined;
          if (!file || startSec === undefined || endSec === undefined) {
            return new Response("Missing file, startSec, endSec", { status: 400 });
          }

          const videoPath = recorder.getRecordingPath(file);
          if (!existsSync(videoPath)) return new Response("Not Found", { status: 404 });

          const storageRoot = realpathSync(recorder.getRecordingPath("."));
          const resolved = realpathSync(videoPath);
          if (!resolved.startsWith(storageRoot)) return new Response("Forbidden", { status: 403 });

          const result = exporter.toGif(resolved, startSec, endSec, cameraId ?? "unknown");
          if (!result) return new Response("GIF export failed", { status: 500 });

          const gifFilename = result.filePath.split("/").pop()!;
          return Response.json({ filename: gifFilename, size: result.size });
        }).catch(() => new Response("Invalid JSON", { status: 400 }));
      }

      /** 录像批量下载 ZIP：打包多个录像文件 */
      if (url.pathname === "/api/recordings/download-zip" && req.method === "POST") {
        return req.json().then(async (body: unknown) => {
          const obj = body as Record<string, unknown>;
          const files = obj.files as string[] | undefined;
          const cameraId = obj.cameraId as string | undefined;
          if (!files || !Array.isArray(files) || files.length === 0) {
            return new Response("Missing files array", { status: 400 });
          }

          /** 防止路径遍历：验证所有文件 */
          const storageRoot = realpathSync(recorder.getRecordingPath("."));
          const resolvedPaths: string[] = [];
          for (const relPath of files) {
            const videoPath = recorder.getRecordingPath(relPath);
            if (!existsSync(videoPath)) return new Response(`Not Found: ${relPath}`, { status: 404 });
            const resolved = realpathSync(videoPath);
            if (!resolved.startsWith(storageRoot)) return new Response("Forbidden", { status: 403 });
            resolvedPaths.push(resolved);
          }

          const result = await exporter.zipBatch(resolvedPaths, cameraId ?? "unknown");
          if (!result) return new Response("ZIP export failed", { status: 500 });

          const zipFilename = result.filePath.split("/").pop()!;
          return Response.json({ filename: zipFilename, size: result.size });
        }).catch(() => new Response("Invalid JSON", { status: 400 }));
      }

      /** 下载导出文件 */
      const exportDownloadMatch = url.pathname.match(/^\/api\/recordings\/export\/(.+\.(mp4|gif|zip))$/);
      if (exportDownloadMatch && req.method === "GET") {
        const filename = exportDownloadMatch[1]!;
        const exportRoot = realpathSync(exporter.getExportPath("."));
        const filePath = exporter.getExportPath(filename);
        if (!existsSync(filePath)) return new Response("Not Found", { status: 404 });
        const resolved = realpathSync(filePath);
        if (!resolved.startsWith(exportRoot)) return new Response("Forbidden", { status: 403 });

        const stat = statSync(filePath);
        const file = Bun.file(filePath);
        const contentType = filename.endsWith(".gif") ? "image/gif" : filename.endsWith(".zip") ? "application/zip" : "video/mp4";
        return new Response(file, {
          headers: {
            "Content-Type": contentType,
            "Content-Length": String(stat.size),
            "Content-Disposition": `attachment; filename="${filename}"`,
          },
        });
      }

      /** 快照列表 */
      if (url.pathname === "/api/snapshots") {
        const cameraId = url.searchParams.get("cameraId") ?? undefined;
        const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 50;
        const snapshots = snapshotStorage.listSnapshots(cameraId);
        return Response.json(snapshots.slice(0, limit));
      }

      /** 快照图片 */
      const snapFileMatch = url.pathname.match(/^\/api\/snapshots\/([^/]+)\/(.+\.jpg)$/);
      if (snapFileMatch) {
        const camId = snapFileMatch[1]!;
        const filename = snapFileMatch[2]!;
        const filePath = snapshotStorage.getSnapshotPath(`${camId}/${filename}`);
        if (!existsSync(filePath)) return new Response("Not Found", { status: 404 });
        /** 防止路径遍历 */
        const snapRoot = realpathSync(snapshotStorage.getSnapshotPath("."));
        const resolved = realpathSync(filePath);
        if (!resolved.startsWith(snapRoot)) return new Response("Forbidden", { status: 403 });
        const file = Bun.file(filePath);
        return new Response(file, {
          headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" },
        });
      }

      /** 快照检测结果元数据 */
      const snapMetaMatch = url.pathname.match(/^\/api\/snapshots\/([^/]+)\/(.+\.json)$/);
      if (snapMetaMatch) {
        const camId = snapMetaMatch[1]!;
        const filename = snapMetaMatch[2]!;
        const meta = snapshotStorage.getSnapshotMeta(`${camId}/${filename}`);
        if (!meta) return new Response("Not Found", { status: 404 });
        return Response.json(meta);
      }

      /** ROI 列表 */
      const roiListMatch = url.pathname.match(/^\/api\/roi\/([^/]+)$/);
      if (roiListMatch && req.method === "GET") {
        const cameraId = roiListMatch[1]!;
        return Response.json(roiStorage.list(cameraId));
      }

      /** ROI 添加 */
      if (url.pathname === "/api/roi" && req.method === "POST") {
        return req.json().then((body: unknown) => {
          const obj = body as Record<string, unknown>;
          const cameraId = obj.cameraId as string | undefined;
          const name = obj.name as string | undefined;
          const points = obj.points as string | undefined;
          if (!cameraId || !points) return new Response("Missing cameraId or points", { status: 400 });
          const id = roiStorage.add(cameraId, name ?? "", points);
          return Response.json({ id });
        }).catch(() => new Response("Invalid JSON", { status: 400 }));
      }

      /** ROI 更新 */
      const roiIdMatch = url.pathname.match(/^\/api\/roi\/item\/(\d+)$/);
      if (roiIdMatch && req.method === "PATCH") {
        const roiId = Number(roiIdMatch[1]!);
        return req.json().then((body: unknown) => {
          const obj = body as Record<string, unknown>;
          const updates: { name?: string; points?: string; enabled?: boolean } = {};
          if (typeof obj.name === "string") updates.name = obj.name;
          if (typeof obj.points === "string") updates.points = obj.points;
          if (typeof obj.enabled === "boolean") updates.enabled = obj.enabled;
          roiStorage.update(roiId, updates);
          return Response.json({ ok: true });
        }).catch(() => new Response("Invalid JSON", { status: 400 }));
      }

      /** ROI 删除 */
      if (roiIdMatch && req.method === "DELETE") {
        const roiId = Number(roiIdMatch[1]!);
        roiStorage.remove(roiId);
        return Response.json({ ok: true });
      }

      /** 告警规则列表 */
      if (url.pathname === "/api/alerts/rules" && req.method === "GET") {
        return Response.json(alertStorage.listRules());
      }

      /** 添加告警规则 */
      if (url.pathname === "/api/alerts/rules" && req.method === "POST") {
        return req.json().then((body: unknown) => {
          const obj = body as Record<string, unknown>;
          const name = obj.name as string | undefined;
          const eventType = obj.eventType as string | undefined;
          if (!name || !eventType) return new Response("Missing name or eventType", { status: 400 });
          const id = alertStorage.addRule({
            name,
            eventType,
            cameraId: (obj.cameraId as string) ?? "",
            labels: (obj.labels as string) ?? "",
            trackNames: (obj.trackNames as string) ?? "",
            windowSeconds: (obj.windowSeconds as number) ?? 60,
            threshold: (obj.threshold as number) ?? 3,
            cooldownSeconds: (obj.cooldownSeconds as number) ?? 300,
            silentStart: (obj.silentStart as string) ?? "",
            silentEnd: (obj.silentEnd as string) ?? "",
            minCount: (obj.minCount as number) ?? 0,
          });
          return Response.json({ id });
        }).catch(() => new Response("Invalid JSON", { status: 400 }));
      }

      /** 更新告警规则 */
      const alertRuleMatch = url.pathname.match(/^\/api\/alerts\/rules\/(\d+)$/);
      if (alertRuleMatch && req.method === "PATCH") {
        const ruleId = Number(alertRuleMatch[1]!);
        return req.json().then((body: unknown) => {
          const obj = body as Record<string, unknown>;
          const updates: Record<string, unknown> = {};
          for (const key of ["name", "eventType", "cameraId", "labels", "trackNames", "windowSeconds", "threshold", "cooldownSeconds", "enabled", "silentStart", "silentEnd", "minCount"]) {
            if (obj[key] !== undefined) updates[key] = obj[key];
          }
          alertStorage.updateRule(ruleId, updates as never);
          return Response.json({ ok: true });
        }).catch(() => new Response("Invalid JSON", { status: 400 }));
      }

      /** 删除告警规则 */
      if (alertRuleMatch && req.method === "DELETE") {
        const ruleId = Number(alertRuleMatch[1]!);
        alertStorage.removeRule(ruleId);
        return Response.json({ ok: true });
      }

      /** 告警历史 */
      if (url.pathname === "/api/alerts/history") {
        const alerts = alertStorage.queryAlerts({
          cameraId: url.searchParams.get("cameraId") ?? undefined,
          since: url.searchParams.has("since") ? Number(url.searchParams.get("since")) : undefined,
          until: url.searchParams.has("until") ? Number(url.searchParams.get("until")) : undefined,
          limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 50,
          offset: url.searchParams.has("offset") ? Number(url.searchParams.get("offset")) : 0,
        });
        const total = alertStorage.countAlerts({
          cameraId: url.searchParams.get("cameraId") ?? undefined,
          since: url.searchParams.has("since") ? Number(url.searchParams.get("since")) : undefined,
          until: url.searchParams.has("until") ? Number(url.searchParams.get("until")) : undefined,
        });
        return Response.json({ alerts, total });
      }

      /** 存储清理状态 */
      if (url.pathname === "/api/cleanup/stats" && req.method === "GET") {
        return Response.json(cleaner.getStats());
      }

      /** 手动触发清理 */
      if (url.pathname === "/api/cleanup/run" && req.method === "POST") {
        const report = cleaner.runCleanup();
        return Response.json(report);
      }

      /** 获取当前 AI 模型信息 */
      if (url.pathname === "/api/ai/model" && req.method === "GET") {
        return Response.json(aiDetector.getModelInfo());
      }

      /** 重新加载 AI 模型 */
      if (url.pathname === "/api/ai/reload-model" && req.method === "POST") {
        return req.json().then(async (body: unknown) => {
          const obj = body as Record<string, unknown>;
          const model = obj.model as string | undefined;
          const result = await aiDetector.reloadModel(model);
          if (!result.ok) return Response.json(result, { status: 400 });
          return Response.json(result);
        }).catch(() => new Response("Invalid JSON", { status: 400 }));
      }

      // ===== PTZ 云台控制 =====

      /** 查询摄像头是否支持 PTZ */
      if (url.pathname.startsWith("/api/ptz/") && url.pathname.endsWith("/status") && req.method === "GET") {
        const cameraId = decodeURIComponent(url.pathname.split("/")[3]!);
        const supported = ptzController.hasPtz(cameraId);
        if (!supported) return Response.json({ supported: false });
        return ptzController.getStatus(cameraId)
          .then(pos => Response.json({ supported: true, position: pos }))
          .catch(err => Response.json({ error: String(err) }, { status: 500 }));
      }

      /** 连续移动（持续按住方向） */
      if (url.pathname.startsWith("/api/ptz/") && url.pathname.endsWith("/move") && req.method === "POST") {
        const cameraId = decodeURIComponent(url.pathname.split("/")[3]!);
        return req.json().then(async (body: unknown) => {
          const obj = body as Record<string, unknown>;
          const vel = obj.velocity as { x?: number; y?: number; zoom?: number } | undefined;
          const timeout = (obj.timeout as number) ?? 0;
          await ptzController.continuousMove(cameraId, vel ?? {}, timeout);
          return Response.json({ ok: true });
        }).catch(err => Response.json({ error: String(err) }, { status: 500 }));
      }

      /** 停止移动 */
      if (url.pathname.startsWith("/api/ptz/") && url.pathname.endsWith("/stop") && req.method === "POST") {
        const cameraId = decodeURIComponent(url.pathname.split("/")[3]!);
        return ptzController.stop(cameraId)
          .then(() => Response.json({ ok: true }))
          .catch(err => Response.json({ error: String(err) }, { status: 500 }));
      }

      /** 绝对移动 */
      if (url.pathname.startsWith("/api/ptz/") && url.pathname.endsWith("/absolute") && req.method === "POST") {
        const cameraId = decodeURIComponent(url.pathname.split("/")[3]!);
        return req.json().then(async (body: unknown) => {
          const obj = body as Record<string, unknown>;
          await ptzController.absoluteMove(cameraId, obj.position as { x?: number; y?: number; zoom?: number });
          return Response.json({ ok: true });
        }).catch(err => Response.json({ error: String(err) }, { status: 500 }));
      }

      /** 相对移动 */
      if (url.pathname.startsWith("/api/ptz/") && url.pathname.endsWith("/relative") && req.method === "POST") {
        const cameraId = decodeURIComponent(url.pathname.split("/")[3]!);
        return req.json().then(async (body: unknown) => {
          const obj = body as Record<string, unknown>;
          await ptzController.relativeMove(cameraId, obj.delta as { x?: number; y?: number; zoom?: number });
          return Response.json({ ok: true });
        }).catch(err => Response.json({ error: String(err) }, { status: 500 }));
      }

      /** 获取预置位列表 */
      if (url.pathname.startsWith("/api/ptz/") && url.pathname.endsWith("/presets") && req.method === "GET") {
        const cameraId = decodeURIComponent(url.pathname.split("/")[3]!);
        return ptzController.getPresets(cameraId)
          .then(presets => Response.json({ presets }))
          .catch(err => Response.json({ error: String(err) }, { status: 500 }));
      }

      /** 跳转预置位 */
      if (url.pathname.startsWith("/api/ptz/") && url.pathname.endsWith("/goto-preset") && req.method === "POST") {
        const cameraId = decodeURIComponent(url.pathname.split("/")[3]!);
        return req.json().then(async (body: unknown) => {
          const obj = body as Record<string, unknown>;
          await ptzController.gotoPreset(cameraId, obj.presetToken as string);
          return Response.json({ ok: true });
        }).catch(err => Response.json({ error: String(err) }, { status: 500 }));
      }

      /** 设置预置位 */
      if (url.pathname.startsWith("/api/ptz/") && url.pathname.endsWith("/set-preset") && req.method === "POST") {
        const cameraId = decodeURIComponent(url.pathname.split("/")[3]!);
        return req.json().then(async (body: unknown) => {
          const obj = body as Record<string, unknown>;
          const token = await ptzController.setPreset(cameraId, obj.presetName as string);
          return Response.json({ ok: true, presetToken: token });
        }).catch(err => Response.json({ error: String(err) }, { status: 500 }));
      }

      /** 删除预置位 */
      if (url.pathname.startsWith("/api/ptz/") && url.pathname.endsWith("/remove-preset") && req.method === "POST") {
        const cameraId = decodeURIComponent(url.pathname.split("/")[3]!);
        return req.json().then(async (body: unknown) => {
          const obj = body as Record<string, unknown>;
          await ptzController.removePreset(cameraId, obj.presetToken as string);
          return Response.json({ ok: true });
        }).catch(err => Response.json({ error: String(err) }, { status: 500 }));
      }

      /** 回到初始位置 */
      if (url.pathname.startsWith("/api/ptz/") && url.pathname.endsWith("/home") && req.method === "POST") {
        const cameraId = decodeURIComponent(url.pathname.split("/")[3]!);
        return ptzController.gotoHomePosition(cameraId)
          .then(() => Response.json({ ok: true }))
          .catch(err => Response.json({ error: String(err) }, { status: 500 }));
      }

      /** 追踪标签 API */
      if (url.pathname === "/api/track-labels" && req.method === "GET") {
        const cameraId = url.searchParams.get("camera_id") ?? "";
        if (!cameraId) return Response.json({ error: "camera_id required" }, { status: 400 });
        return Response.json(trackLabelStorage.listByCamera(cameraId));
      }

      if (url.pathname === "/api/track-labels" && req.method === "POST") {
        const body = await req.json() as { cameraId: string; trackId: number; label: string; name: string; snapshotPath?: string };
        if (!body.cameraId || !body.trackId || !body.name) {
          return Response.json({ error: "cameraId, trackId, name required" }, { status: 400 });
        }
        const result = trackLabelStorage.upsert(body.cameraId, body.trackId, body.label, body.name, body.snapshotPath);
        /** 同步 customName 到 TrackStorage */
        if (body.trackId && body.name) {
          trackStorage.setCustomName(body.trackId, body.name);
        }
        return Response.json(result);
      }

      if (url.pathname.startsWith("/api/track-labels/") && req.method === "DELETE") {
        const id = parseInt(url.pathname.split("/").pop() ?? "");
        if (!id) return Response.json({ error: "invalid id" }, { status: 400 });
        const ok = trackLabelStorage.remove(id);
        return Response.json({ ok });
      }

      /** 追踪目标列表 */
      if (url.pathname === "/api/tracks" && req.method === "GET") {
        return Response.json(trackStorage.listTracks());
      }

      /** 更新追踪目标自定义名称 */
      if (url.pathname.startsWith("/api/tracks/") && req.method === "PATCH") {
        const trackId = parseInt(url.pathname.split("/").pop() ?? "");
        if (!trackId) return Response.json({ error: "invalid trackId" }, { status: 400 });
        const body = await req.json() as { customName?: string };
        trackStorage.setCustomName(trackId, body.customName ?? "");
        const updated = trackStorage.getTrack(trackId);
        return Response.json(updated);
      }

      /** 追踪目标快照图片 */
      if (url.pathname.startsWith("/api/tracks/snapshot/") && req.method === "GET") {
        const filename = url.pathname.slice("/api/tracks/snapshot/".length);
        const filePath = trackStorage.getSnapshotPath(filename);
        if (!existsSync(filePath)) return new Response("Not Found", { status: 404 });
        const file = Bun.file(filePath);
        return new Response(file);
      }

      /** API 路径未匹配 → 404 */
      if (url.pathname.startsWith("/api/")) {
        return new Response("Not Found", { status: 404 });
      }

      /** 静态文件服务：服务前端构建产物 */
      return serveStatic(url.pathname);
    }

  Bun.serve({
    port,
    async fetch(req, server) {
      /** CORS 预检请求 */
      if (req.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: { ...CORS_HEADERS, "Access-Control-Max-Age": "86400" },
        });
      }

      /** WebSocket 升级（需要认证） */
      if (req.headers.get("upgrade") === "websocket") {
        const url = new URL(req.url);
        if (url.pathname === "/api/events") {
          if (authConfig.token && !checkAuth(authConfig, req)) {
            return new Response("Unauthorized", { status: 401 });
          }
          server.upgrade(req);
          return;
        }
      }

      const res = await handleRequest(req);
      if (res) return corsify(res);
      return corsify(new Response("Not Found", { status: 404 }));
    },
    websocket: {
      open(ws) {
        wsClients.add(ws);
        console.log(`[WS] 客户端连接，当前 ${wsClients.size} 个`);
      },
      close(ws) {
        wsClients.delete(ws);
        console.log(`[WS] 客户端断开，当前 ${wsClients.size} 个`);
      },
      message() {
        /** 暂不处理客户端发来的消息 */
      },
    },
  });

  /** 帧推送节流：每个摄像头至少间隔 50ms 推送一帧（~20fps） */
  const lastFrameSent = new Map<string, number>();
  const FRAME_THROTTLE_MS = 50;

  /** 预分配 header 长度 buffer（4 字节复用） */
  const headerLenBuf = new Uint8Array(4);
  const headerLenView = new DataView(headerLenBuf.buffer);

  /** 监听事件并推送给所有 WebSocket 客户端 */
  for (const event of PUSH_EVENTS) {
    eventBus.on(event, (payload) => {
      let frameData: Buffer | null = null;

      /** 构建 JSON 头（只保留事件类型和元数据，不含二进制） */
      let header: Record<string, unknown>;

      if (event === "frame") {
        /** 帧事件：轻量 header */
        const { cameraId, timestamp } = payload as { cameraId: string; timestamp: number; data: Buffer };
        frameData = (payload as { data: Buffer }).data;
        header = { event, cameraId, timestamp };
        /** 帧节流 */
        const now = Date.now();
        const lastSent = lastFrameSent.get(cameraId) ?? 0;
        if (now - lastSent < FRAME_THROTTLE_MS) return;
        lastFrameSent.set(cameraId, now);
      } else if (event === "detect") {
        const detectPayload = payload as { cameraId: string; timestamp: number; detections: unknown[]; changed?: boolean; inferMs?: number };
        header = { event, cameraId: detectPayload.cameraId, timestamp: detectPayload.timestamp, detections: detectPayload.detections, changed: detectPayload.changed, inferMs: detectPayload.inferMs };
      } else {
        header = { event, ...payload };
      }

      if (wsClients.size === 0) return;

      /** 二进制协议：[4字节头长度 LE uint32][JSON头][可选二进制帧] */
      const headerBuf = Buffer.from(JSON.stringify(header), "utf-8");
      headerLenView.setUint32(0, headerBuf.length, true);

      /** 使用 Uint8Array.set 避免 Buffer.concat 的大内存拷贝 */
      const message = new Uint8Array(4 + headerBuf.length + (frameData?.length ?? 0));
      message.set(headerLenBuf, 0);
      message.set(headerBuf, 4);
      if (frameData) {
        message.set(frameData, 4 + headerBuf.length);
      }

      for (const ws of wsClients) {
        ws.send(message);
      }
    });
  }

  console.log(`[Server] HTTP + WebSocket 服务已启动: http://localhost:${port}`);
}

/** MIME 类型映射 */
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

/** 前端构建产物目录 */
const STATIC_DIR = resolve(import.meta.dir, "../../web/dist");

/** 服务静态文件，SPA fallback 到 index.html */
function serveStatic(pathname: string): Response {
  /** 去掉前导 / */
  let filePath = resolve(STATIC_DIR, pathname.slice(1) || "index.html");

  /** 安全检查：确保路径在静态目录内 */
  if (!filePath.startsWith(STATIC_DIR)) {
    return new Response("Forbidden", { status: 403 });
  }

  /** 如果文件不存在，SPA fallback 到 index.html */
  if (!existsSync(filePath)) {
    filePath = resolve(STATIC_DIR, "index.html");
  }

  if (!existsSync(filePath)) {
    return new Response("Not Found", { status: 404 });
  }

  const ext = extname(filePath);
  const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
  const file = Bun.file(filePath);

  return new Response(file, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=31536000",
    },
  });
}
