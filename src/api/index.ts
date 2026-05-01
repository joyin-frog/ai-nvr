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
import { type PreferencesStorage } from "@/storage/preferences";
import { type StorageFs } from "@/storage/storage-fs";
import { addCameraToConfig, removeCameraFromConfig, updateCameraInConfig, loadConfig, type AuthConfig } from "@/config";
import { checkAuth } from "@/auth";
import { existsSync, statSync, realpathSync } from "node:fs";
import { resolve, extname } from "node:path";
import { spawnSync } from "node:child_process";

/** WebSocket 客户端集合 */
type WsClient = import("bun").ServerWebSocket<{ type?: string; cameraId?: string }>;
const wsClients = new Set<WsClient>();

/** WebSocket 心跳检测：每 30 秒 ping，60 秒无 pong 关闭假死连接 */
const WS_PING_INTERVAL = 30_000;
const WS_PONG_TIMEOUT = 60_000;
const wsLastPong = new WeakMap<WsClient, number>();
let wsHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
function startWsHeartbeat() {
  if (wsHeartbeatTimer) return;
  wsHeartbeatTimer = setInterval(() => {
    const now = Date.now();
    for (const ws of wsClients) {
      const lastPong = wsLastPong.get(ws) ?? now;
      if (now - lastPong > WS_PONG_TIMEOUT) {
        console.log(`[WS] 心跳超时，关闭连接`);
        ws.close();
        wsClients.delete(ws);
        continue;
      }
      try {
        ws.send(JSON.stringify({ event: "ping" }));
      } catch {
        wsClients.delete(ws);
      }
    }
  }, WS_PING_INTERVAL);
}

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
const PUSH_EVENTS: EventName[] = ["frame", "motion", "detect", "camera:online", "camera:offline", "camera:lowfps", "alert", "track:appeared", "track:disappeared", "track:label-updated", "track:enter-zone", "track:leave-zone", "track:dwell", "track:speed", "track:match-suggest"];

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
  preferencesStorage: PreferencesStorage,
  storageFs: StorageFs,
  alertSnapshotStorage?: SnapshotStorage,
): void {
  /** 登录速率限制：IP → { count, resetAt } */
  const loginRateLimits = new Map<string, { count: number; resetAt: number }>();
  /** 定期清理过期的速率限制记录 */
  setInterval(() => {
    const now = Date.now();
    for (const [ip, bucket] of loginRateLimits) {
      if (now - bucket.resetAt > 120_000) loginRateLimits.delete(ip);
    }
  }, 120_000);

  /** fMP4 流连接管理 */
  const fmp4Unsubs = new WeakMap<WsClient, (() => void)[]>();

  /**
   * fMP4 二进制协议：
   * Init segment: [0x01][2B codec长度 LE uint16][codec ASCII][fMP4 data]
   * Media segment: [0x02][fMP4 data]
   */
  const FMP4_TYPE_INIT = 0x01;
  const FMP4_TYPE_MEDIA = 0x02;

  /** 封装 fMP4 init segment 为带协议头的二进制消息 */
  function encodeFmp4Init(codec: string, data: Buffer): Buffer {
    const codecBuf = Buffer.from(codec, "ascii");
    /** 1字节类型 + 2字节codec长度 + codec + fMP4 data */
    const msg = Buffer.alloc(1 + 2 + codecBuf.length + data.length);
    msg[0] = FMP4_TYPE_INIT;
    msg.writeUInt16LE(codecBuf.length, 1);
    codecBuf.copy(msg, 3);
    data.copy(msg, 3 + codecBuf.length);
    return msg;
  }

  /** 封装 fMP4 media segment（共享 Buffer，多客户端复用） */
  function encodeFmp4Media(data: Buffer): Buffer {
    const msg = Buffer.alloc(1 + data.length);
    msg[0] = FMP4_TYPE_MEDIA;
    data.copy(msg, 1);
    return msg;
  }

  /** 缓存最近编码的 media segment（避免 N 客户端重复编码） */
  let cachedMediaMsg: { dataPtr: Buffer; encoded: Buffer } | null = null;

  function getOrEncodeMedia(data: Buffer): Buffer {
    if (cachedMediaMsg && cachedMediaMsg.dataPtr === data) {
      return cachedMediaMsg.encoded;
    }
    const encoded = encodeFmp4Media(data);
    cachedMediaMsg = { dataPtr: data, encoded };
    return encoded;
  }

  function handleFmp4Connection(ws: WsClient, cameraId: string, camMgr: CameraManager, bus: EventBus) {
    const extractor = camMgr.getFmp4Extractor(cameraId);
    const unsubs: (() => void)[] = [];

    /** 没有 fMP4 提取器时直接关闭，让前端回退到 Canvas */
    if (!extractor) {
      console.warn(`[fMP4] 摄像头 ${cameraId} 没有 fMP4 流，关闭连接`);
      ws.close();
      return;
    }

    /** 发送缓存的 init segment（带协议头） */
    if (extractor.initSegment) {
      ws.send(encodeFmp4Init(extractor.initSegment.codec, extractor.initSegment.data));
    }

    /** 发送缓存的最近 media segment（立即显示画面，消除黑屏等待） */
    if (extractor.lastMediaSegment) {
      ws.send(getOrEncodeMedia(extractor.lastMediaSegment));
    }

    /** 监听新的 init segment */
    const unsubInit = bus.on("fmp4:init", (payload) => {
      if (payload.cameraId === cameraId) {
        ws.send(encodeFmp4Init(payload.segment.codec, payload.segment.data));
      }
    });
    unsubs.push(unsubInit);

    /** 监听 media segment */
    const unsubSeg = bus.on("fmp4:segment", (payload) => {
      if (payload.cameraId === cameraId) {
        ws.send(getOrEncodeMedia(payload.data));
      }
    });
    unsubs.push(unsubSeg);

    fmp4Unsubs.set(ws, unsubs);
    console.log(`[fMP4] 客户端连接: ${cameraId}`);
  }

  function cleanupFmp4Connection(ws: WsClient) {
    const unsubs = fmp4Unsubs.get(ws);
    if (unsubs) {
      for (const unsub of unsubs) unsub();
    }
    console.log(`[fMP4] 客户端断开`);
  }

  /** 处理 HTTP 请求（不含 CORS 和 WebSocket 逻辑） */
  async function handleRequest(req: Request): Promise<Response | undefined> {
    const url = new URL(req.url);

    if (url.pathname === "/api/auth/check") {
      return Response.json({ enabled: !!authConfig.token });
    }

    /** 登录端点：验证 token（带速率限制） */
    if (url.pathname === "/api/auth/login" && req.method === "POST") {
        /** IP 速率限制：每分钟最多 10 次登录尝试 */
        const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
          ?? req.headers.get("x-real-ip")
          ?? "unknown";
        const now = Date.now();
        let bucket = loginRateLimits.get(clientIp);
        if (!bucket || now - bucket.resetAt > 60_000) {
          bucket = { count: 0, resetAt: now };
          loginRateLimits.set(clientIp, bucket);
        }
        bucket.count++;
        if (bucket.count > 10) {
          return new Response("Too many login attempts", { status: 429 });
        }

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
            "GET /api/recordings/search?label=",
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

        /**
         * 轻量化响应：从 detail JSON 中提取摘要字段，不返回原始大 detail
         * detect 事件：提取标签摘要（如 "person ×2, car ×1"）
         * motion 事件：提取 ratio
         * 快照 URL 按需生成，不逐条查文件系统
         */
        const events = rawEvents.map(ev => {
          let summary: string | null = null;
          let snapshotUrl: string | null = null;
          let detections: unknown = null;

          if (ev.type === "detect" && ev.detail) {
            const snapPath = snapshotStorage.findSnapshotPath(ev.camera_id, ev.timestamp);
            if (snapPath) {
              snapshotUrl = `/api/snapshots/${snapPath}`;
              const meta = snapshotStorage.getSnapshotMeta(snapPath);
              if (meta?.detections) detections = meta.detections;
            }
            /** 从 detail 提取标签摘要 */
            const detailObj = JSON.parse(ev.detail);
            const dets = detailObj?.detections;
            if (Array.isArray(dets)) {
              const labelCounts = new Map<string, number>();
              for (const d of dets) {
                const name = d.trackName ?? d.label;
                labelCounts.set(name, (labelCounts.get(name) ?? 0) + 1);
              }
              summary = [...labelCounts.entries()].map(([l, c]) => c > 1 ? `${l} ×${c}` : l).join(", ");
            }
          } else if (ev.type === "alert" && alertSnapshotStorage) {
            const snapPath = alertSnapshotStorage.findSnapshotPath(ev.camera_id, ev.timestamp);
            if (snapPath) snapshotUrl = `/api/alert-snapshots/${snapPath}`;
            if (ev.detail) {
              const detailObj = JSON.parse(ev.detail);
              summary = detailObj?.ruleName ?? null;
            }
          } else if (ev.type === "motion" && ev.detail) {
            const detailObj = JSON.parse(ev.detail);
            if (typeof detailObj?.ratio === "number") {
              summary = `变动 ${(detailObj.ratio * 100).toFixed(1)}%`;
            }
          }

          return {
            id: ev.id,
            type: ev.type,
            camera_id: ev.camera_id,
            timestamp: ev.timestamp,
            summary,
            snapshotUrl,
            detections,
            starred: ev.starred,
          };
        });
        return Response.json({ events, total });
      }

      /** 事件历史 CSV 导出 */
      if (url.pathname === "/api/events/export") {
        const queryOpts = {
          type: url.searchParams.get("type") ?? undefined,
          cameraId: url.searchParams.get("cameraId") ?? undefined,
          since: url.searchParams.has("since") ? Number(url.searchParams.get("since")) : undefined,
          until: url.searchParams.has("until") ? Number(url.searchParams.get("until")) : undefined,
          search: url.searchParams.get("search") ?? undefined,
          starred: url.searchParams.get("starred") === "true" ? true : undefined,
          limit: 10000,
          offset: 0,
        };
        const rawEvents = eventStorage.query(queryOpts);

        /** CSV 转义 */
        function csvEscape(val: string): string {
          if (val.includes(",") || val.includes("\"") || val.includes("\n")) {
            return `"${val.replace(/"/g, "\"\"")}"`;
          }
          return val;
        }

        const header = "id,type,camera_id,timestamp,detail,starred";
        const rows = rawEvents.map(ev => {
          const ts = new Date(ev.timestamp).toISOString();
          return `${ev.id},${ev.type},${csvEscape(ev.camera_id)},${ts},${csvEscape(ev.detail ?? "")},${ev.starred ? 1 : 0}`;
        });
        const csv = [header, ...rows].join("\n");

        return new Response(csv, {
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="events_${new Date().toISOString().slice(0, 10)}.csv"`,
          },
        });
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

      /** 单个事件完整详情（按需加载，避免列表返回大 detail） */
      const eventDetailMatch = url.pathname.match(/^\/api\/events\/(\d+)$/);
      if (eventDetailMatch && req.method === "GET") {
        const id = Number(eventDetailMatch[1]);
        const ev = eventStorage.getById(id);
        if (!ev) return new Response("Not Found", { status: 404 });
        /** 关联快照 */
        let snapshotUrl: string | null = null;
        if (ev.type === "detect") {
          const snapPath = snapshotStorage.findSnapshotPath(ev.camera_id, ev.timestamp);
          if (snapPath) snapshotUrl = `/api/snapshots/${snapPath}`;
        } else if (ev.type === "alert" && alertSnapshotStorage) {
          const snapPath = alertSnapshotStorage.findSnapshotPath(ev.camera_id, ev.timestamp);
          if (snapPath) snapshotUrl = `/api/alert-snapshots/${snapPath}`;
        }
        return Response.json({ ...ev, snapshotUrl });
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
        const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined;
        const all = recorder.listRecordings(cameraId, since, until);
        return Response.json(limit && limit > 0 ? all.slice(0, limit) : all);
      }

      /** 录像智能搜索：按 AI 检测标签查找包含特定目标的录像 */
      if (url.pathname === "/api/recordings/search" && req.method === "GET") {
        const label = url.searchParams.get("label") ?? "";
        const cameraId = url.searchParams.get("cameraId") ?? undefined;
        const since = url.searchParams.has("since") ? Number(url.searchParams.get("since")) : undefined;
        const until = url.searchParams.has("until") ? Number(url.searchParams.get("until")) : undefined;
        if (!label) return Response.json({ error: "label is required" }, { status: 400 });

        /** 搜索 detect 事件的 detail 中包含该 label 的记录 */
        const events = eventStorage.query({
          type: "detect",
          cameraId,
          since,
          until,
          search: `"label":"${label}"`,
          limit: 500,
        });

        /** 按 cameraId + timestamp 映射到录像文件 */
        const matchedCameraIds = new Set(events.map(e => e.camera_id));
        const result: Array<{ filename: string; cameraId: string; startTime: number; endTime: number; size: number; matchCount: number }> = [];
        for (const camId of matchedCameraIds) {
          const timestamps = events.filter(e => e.camera_id === camId).map(e => e.timestamp);
          const minTs = Math.min(...timestamps);
          const maxTs = Math.max(...timestamps);
          /** 查找覆盖这个时间范围的录像 */
          const recs = recorder.listRecordings(camId, since ?? minTs - 60000, until ?? maxTs + 60000);
          for (const rec of recs) {
            const matchEvents = events.filter(e =>
              e.camera_id === rec.cameraId && e.timestamp >= rec.startTime && e.timestamp <= rec.endTime
            );
            if (matchEvents.length > 0) {
              result.push({ ...rec, matchCount: matchEvents.length });
            }
          }
        }
        result.sort((a, b) => b.startTime - a.startTime);
        return Response.json(result);
      }

      /** 录像文件播放（支持 Range 请求，MP4 seek 必需） */
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
        const fileSize = stat.size;

        /** 处理 Range 请求（浏览器 MP4 seek 必需） */
        const rangeHeader = req.headers.get("range");
        if (rangeHeader) {
          const match = rangeHeader.match(/^bytes=(\d+)-(\d*)$/);
          if (match) {
            const start = parseInt(match[1]!, 10);
            const end = match[2] ? parseInt(match[2]!, 10) : fileSize - 1;
            const clampedEnd = Math.min(end, fileSize - 1);
            if (start > clampedEnd || start >= fileSize) {
              return new Response("Range Not Satisfiable", { status: 416, headers: { "Content-Range": `bytes */${fileSize}` } });
            }
            const slice = Bun.file(filePath).slice(start, clampedEnd + 1);
            return new Response(slice, {
              status: 206,
              headers: {
                "Content-Type": "video/mp4",
                "Content-Length": String(clampedEnd - start + 1),
                "Content-Range": `bytes ${start}-${clampedEnd}/${fileSize}`,
                "Accept-Ranges": "bytes",
              },
            });
          }
        }

        const file = Bun.file(filePath);
        return new Response(file, {
          headers: {
            "Content-Type": "video/mp4",
            "Content-Length": String(fileSize),
            "Accept-Ranges": "bytes",
          },
        });
      }

      /** 删除录像文件 */
      if (recordingMatch && req.method === "DELETE") {
        const camId = recordingMatch[1]!;
        const filename = recordingMatch[2]!;
        const relPath = `recordings/${camId}/${filename}`;
        const filePath = storageFs.resolve(relPath);
        if (!existsSync(filePath)) return new Response("Not Found", { status: 404 });
        /** 路径遍历防护 */
        const storageRoot = realpathSync(storageFs.resolve("recordings"));
        const resolved = realpathSync(filePath);
        if (!resolved.startsWith(storageRoot)) return new Response("Forbidden", { status: 403 });
        storageFs.deleteFile(relPath);
        return Response.json({ ok: true });
      }

      /** 获取标注后的图片（按需生成） */
      /** 标注图：优先使用已保存的快照文件，回退到按需生成 */
      const annotatedMatch = url.pathname.match(/^\/api\/detection\/annotated\/(.+)$/);
      if (annotatedMatch) {
        const cameraId = annotatedMatch[1]!;
        /** 优先返回最新保存的快照文件（零 CPU 开销） */
        const latestSnap = snapshotStorage.getLatestSnapshotPath(cameraId);
        if (latestSnap) {
          const snapFilePath = snapshotStorage.getSnapshotPath(latestSnap);
          if (existsSync(snapFilePath)) {
            return new Response(Bun.file(snapFilePath), {
              headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-cache" },
            });
          }
        }
        /** 回退：按需生成标注图 */
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

      /** 告警快照列表 */
      if (url.pathname === "/api/alert-snapshots" && alertSnapshotStorage) {
        const cameraId = url.searchParams.get("cameraId") ?? undefined;
        const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 50;
        const snapshots = alertSnapshotStorage.listSnapshots(cameraId);
        return Response.json(snapshots.slice(0, limit));
      }

      /** 告警快照图片文件 */
      const alertSnapMatch = url.pathname.match(/^\/api\/alert-snapshots\/([^/]+)\/(.+\.jpg)$/);
      if (alertSnapMatch && alertSnapshotStorage) {
        const camId = alertSnapMatch[1]!;
        const filename = alertSnapMatch[2]!;
        const filePath = alertSnapshotStorage.getSnapshotPath(`${camId}/${filename}`);
        if (!existsSync(filePath)) return new Response("Not Found", { status: 404 });
        const snapRoot = realpathSync(alertSnapshotStorage.getSnapshotPath("."));
        const resolved = realpathSync(filePath);
        if (!resolved.startsWith(snapRoot)) return new Response("Forbidden", { status: 403 });
        return new Response(Bun.file(filePath), {
          headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" },
        });
      }

      /** ROI 列表（全部） */
      if (url.pathname === "/api/roi" && req.method === "GET") {
        return Response.json(roiStorage.listAll());
      }

      /** ROI 列表（按摄像头） */
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
            roiId: (obj.roiId as number) ?? 0,
            minSpeed: (obj.minSpeed as number) ?? 0,
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
          for (const key of ["name", "eventType", "cameraId", "labels", "trackNames", "windowSeconds", "threshold", "cooldownSeconds", "enabled", "silentStart", "silentEnd", "minCount", "roiId", "minSpeed"]) {
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

      /** 用户偏好设置 API */
      if (url.pathname === "/api/preferences" && req.method === "GET") {
        return Response.json(preferencesStorage.getAllAsRecord());
      }

      if (url.pathname === "/api/preferences" && req.method === "PATCH") {
        const body = await req.json() as Record<string, unknown>;
        /** 只接受 nvr- 前缀的键 */
        const filtered: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(body)) {
          if (key.startsWith("nvr-")) {
            filtered[key] = value;
          }
        }
        if (Object.keys(filtered).length === 0) {
          return Response.json({ error: "no valid keys (must start with nvr-)" }, { status: 400 });
        }
        preferencesStorage.setMany(filtered);
        return Response.json({ ok: true });
      }

      /** 全量校准磁盘用量 */
      if (url.pathname === "/api/storage/calibrate" && req.method === "POST") {
        diskUsage.calibrate();
        return Response.json({ ok: true });
      }

      /** 追踪标签 API */
      if (url.pathname === "/api/track-labels" && req.method === "GET") {
        const cameraId = url.searchParams.get("camera_id") ?? url.searchParams.get("cameraId") ?? "";
        if (!cameraId) return Response.json(trackLabelStorage.listAll());
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
        /** 广播标签更新给其他客户端 */
        eventBus.emit("track:label-updated", {
          cameraId: body.cameraId,
          trackId: body.trackId,
          name: body.name,
        });
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
        const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 200;
        const all = trackStorage.listTracks();
        return Response.json(all.slice(0, limit));
      }

      /** 未命名目标的 dHash 匹配建议 */
      if (url.pathname === "/api/tracks/suggestions" && req.method === "GET") {
        return Response.json(trackStorage.getSuggestions());
      }

      /** 更新追踪目标自定义名称 */
      if (url.pathname.startsWith("/api/tracks/") && req.method === "PATCH") {
        const trackId = parseInt(url.pathname.split("/").pop() ?? "");
        if (!trackId) return Response.json({ error: "invalid trackId" }, { status: 400 });
        const body = await req.json() as { customName?: string };
        trackStorage.setCustomName(trackId, body.customName ?? "");
        const updated = trackStorage.getTrack(trackId);
        /** 广播标签更新给其他客户端 */
        if (updated && body.customName) {
          for (const cameraId of updated.cameraIds) {
            eventBus.emit("track:label-updated", {
              cameraId,
              trackId,
              name: body.customName,
            });
          }
        }
        return Response.json(updated);
      }

      /** 删除追踪目标 */
      /** 合并追踪目标 */
      if (url.pathname === "/api/tracks/merge" && req.method === "POST") {
        const body = await req.json() as { sourceId?: number; targetId?: number };
        if (!body.sourceId || !body.targetId) {
          return Response.json({ error: "sourceId and targetId required" }, { status: 400 });
        }
        const ok = trackStorage.merge(body.sourceId, body.targetId);
        if (!ok) return Response.json({ error: "merge failed" }, { status: 400 });
        /** 广播更新 */
        const updated = trackStorage.getTrack(body.targetId);
        if (updated?.customName) {
          for (const cameraId of updated.cameraIds) {
            eventBus.emit("track:label-updated", {
              cameraId,
              trackId: body.targetId,
              name: updated.customName,
            });
          }
        }
        return Response.json({ ok: true, track: updated });
      }

      const trackDeleteMatch = url.pathname.match(/^\/api\/tracks\/(\d+)$/);
      if (trackDeleteMatch && req.method === "DELETE") {
        const trackId = parseInt(trackDeleteMatch[1]!);
        const ok = trackStorage.remove(trackId);
        if (!ok) return Response.json({ error: "not found" }, { status: 404 });
        return Response.json({ ok: true });
      }

      /** 追踪目标检测事件历史 */
      const trackEventsMatch = url.pathname.match(/^\/api\/tracks\/(\d+)\/events$/);
      if (trackEventsMatch && req.method === "GET") {
        const trackId = parseInt(trackEventsMatch[1]!);
        const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 50;
        /** 搜索所有包含该 trackId 的事件（detect + track:* 行为事件） */
        const searchStr = `"trackId":${trackId}`;
        const detectEvents = eventStorage.query({ type: "detect", search: searchStr, limit });
        const trackEvents = eventStorage.query({ search: searchStr, limit });
        /** 合并去重（按 id） */
        const seen = new Set(detectEvents.map((e: { id: number }) => e.id));
        const merged = [...detectEvents];
        for (const ev of trackEvents) {
          if (!seen.has((ev as { id: number }).id)) {
            seen.add((ev as { id: number }).id);
            merged.push(ev);
          }
        }
        /** 按时间倒序 */
        merged.sort((a: { timestamp: number }, b: { timestamp: number }) => b.timestamp - a.timestamp);
        return Response.json(merged.slice(0, limit));
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

  Bun.serve<{ type?: string; cameraId?: string }>({
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
          server.upgrade(req, { data: { type: "events" } });
          return;
        }
        /** fMP4 流端点：/api/stream/:cameraId */
        const streamMatch = url.pathname.match(/^\/api\/stream\/(.+)$/);
        if (streamMatch) {
          if (authConfig.token && !checkAuth(authConfig, req)) {
            return new Response("Unauthorized", { status: 401 });
          }
          const cameraId = decodeURIComponent(streamMatch[1]!);
          server.upgrade(req, { data: { type: "fmp4", cameraId } });
          return;
        }
      }

      const res = await handleRequest(req);
      if (res) return corsify(res);
      return corsify(new Response("Not Found", { status: 404 }));
    },
    websocket: {
      open(ws) {
        const data = (ws as unknown as { data?: { type?: string; cameraId?: string } }).data;
        /** fMP4 流连接 */
        if (data?.type === "fmp4" && data.cameraId) {
          handleFmp4Connection(ws, data.cameraId, cameraManager, eventBus);
          return;
        }
        /** 事件推送连接 */
        wsClients.add(ws);
        wsLastPong.set(ws, Date.now());
        startWsHeartbeat();
        console.log(`[WS] 客户端连接，当前 ${wsClients.size} 个`);
      },
      close(ws) {
        const data = (ws as unknown as { data?: { type?: string } }).data;
        if (data?.type === "fmp4") {
          cleanupFmp4Connection(ws);
          return;
        }
        wsClients.delete(ws);
        console.log(`[WS] 客户端断开，当前 ${wsClients.size} 个`);
      },
      message(ws, raw) {
        if (typeof raw !== "string") return;
        /** 心跳 pong 响应 */
        try {
          const parsed = JSON.parse(raw);
          if (parsed.type === "pong") {
            wsLastPong.set(ws, Date.now());
            return;
          }
        } catch { /* not JSON, continue */ }
        /** 处理客户端订阅消息：{"type":"subscribe","cameraIds":["cam1","cam2"]} */
        if (typeof raw !== "string") return;
        let msg: { type: string; cameraIds?: string[] };
        try { msg = JSON.parse(raw); } catch { return; }
        if (msg.type === "subscribe" && Array.isArray(msg.cameraIds)) {
          (ws as unknown as { subscribedCameras: Set<string> }).subscribedCameras = new Set(msg.cameraIds);
        } else if (msg.type === "unsubscribe") {
          (ws as unknown as { subscribedCameras?: Set<string> }).subscribedCameras = undefined;
        }
      },
    },
  });

  /**
   * 帧推送：事件驱动 + 节流
   * 帧到达后立即检查是否可推送，每路摄像头独立节流（30fps 上限）
   * 相比定时器轮询，减少平均 16ms 推送延迟
   */

  /** 每路摄像头最新帧缓存 */
  const latestFrameByCamera = new Map<string, { data: Buffer; timestamp: number }>();

  /** 每路摄像头上次推送时间（用于节流） */
  const lastPushTimeByCamera = new Map<string, number>();

  /**
   * 根据活跃摄像头数量动态计算帧推送节流间隔
   * 1-2 路: 30fps (33ms)，3-4 路: 20fps (50ms)，5+ 路: 15fps (67ms)
   */
  function getThrottleMs(): number {
    const camCount = latestFrameByCamera.size;
    if (camCount <= 2) return 33;
    if (camCount <= 4) return 50;
    return 67;
  }

  /** 是否有待推送的帧（pending push flag） */
  let pushScheduled = false;

  /** 执行帧推送 */
  function flushFrames() {
    pushScheduled = false;
    if (wsClients.size === 0 || latestFrameByCamera.size === 0) return;

    const now = Date.now();
    for (const [cameraId, frame] of latestFrameByCamera) {
      /** 节流：每路摄像头不超过 30fps */
      const lastPush = lastPushTimeByCamera.get(cameraId) ?? 0;
      if (now - lastPush < getThrottleMs()) continue;

      latestFrameByCamera.delete(cameraId);
      lastPushTimeByCamera.set(cameraId, now);

      const header = { event: "frame", cameraId, timestamp: frame.timestamp };
      const headerBuf = Buffer.from(JSON.stringify(header), "utf-8");
      headerLenView.setUint32(0, headerBuf.length, true);

      const message = new Uint8Array(4 + headerBuf.length + frame.data.length);
      message.set(headerLenBuf, 0);
      message.set(headerBuf, 4);
      message.set(frame.data, 4 + headerBuf.length);

      for (const ws of wsClients) {
        /** 客户端订阅过滤：只推送给订阅了该摄像头的客户端 */
        const subscribed = (ws as unknown as { subscribedCameras?: Set<string> }).subscribedCameras;
        if (subscribed && !subscribed.has(cameraId)) continue;
        try {
          ws.send(message);
        } catch {
          /** 单个客户端发送失败不影响其他客户端 */
        }
      }
    }

    /** 如果还有被节流的帧，安排下次 flush */
    if (latestFrameByCamera.size > 0 && !pushScheduled) {
      pushScheduled = true;
      setTimeout(flushFrames, getThrottleMs());
    }
  }

  /** 调度帧推送（事件驱动） */
  function schedulePush() {
    if (pushScheduled) return;
    pushScheduled = true;
    /** 用 setImmediate 或 setTimeout(0) 实现微任务延迟 */
    setTimeout(flushFrames, 0);
  }

  /** 预分配 header 长度 buffer（4 字节复用） */
  const headerLenBuf = new Uint8Array(4);
  const headerLenView = new DataView(headerLenBuf.buffer);

  /** 监听事件并推送给所有 WebSocket 客户端 */
  for (const event of PUSH_EVENTS) {
    eventBus.on(event, (payload) => {
      if (event === "frame") {
        /** 帧事件：缓存最新帧，事件驱动推送 */
        const { cameraId, timestamp, data } = payload as { cameraId: string; timestamp: number; data: Buffer };
        latestFrameByCamera.set(cameraId, { data, timestamp });
        schedulePush();
        return;
      }

      /** 非帧事件：立即推送 */
      let header: Record<string, unknown>;

      if (event === "detect") {
        const detectPayload = payload as { cameraId: string; timestamp: number; detections: Array<{ label: string; score: number; box: unknown; trackId?: number; trackName?: string }>; changed?: boolean; inferMs?: number };
        /** 只推送 importantLabels 中的检测结果给前端，减少 WS 带宽 */
        const importantLabels = runtimeConfig.get().ai.importantLabels;
        const importantSet = importantLabels.length > 0 ? new Set(importantLabels.map(l => l.toLowerCase())) : null;
        const filteredDetections = importantSet
          ? detectPayload.detections.filter(d => importantSet.has((d.label as string).toLowerCase()))
          : detectPayload.detections;
        header = { event, cameraId: detectPayload.cameraId, timestamp: detectPayload.timestamp, detections: filteredDetections, changed: detectPayload.changed, inferMs: detectPayload.inferMs };
      } else {
        header = { event, ...payload };
      }

      if (wsClients.size === 0) return;

      /** 二进制协议：[4字节头长度 LE uint32][JSON头] */
      const headerBuf = Buffer.from(JSON.stringify(header), "utf-8");
      headerLenView.setUint32(0, headerBuf.length, true);

      const message = new Uint8Array(4 + headerBuf.length);
      message.set(headerLenBuf, 0);
      message.set(headerBuf, 4);

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
