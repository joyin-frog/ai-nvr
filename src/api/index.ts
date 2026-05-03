import { join } from "node:path";
import { type CameraManager } from "@/camera/manager";
import { type EventBus, type EventName } from "@/event-bus";
import { type Annotator } from "@/ai/annotator";
import { type EventStorage } from "@/storage/events";
import { type MotionRecorder } from "@/storage/recorder";
import { TrackStorage } from "@/storage/tracks";
import { type SystemMonitor } from "@/monitor";
import { type RuntimeConfig } from "@/runtime-config";
import { type SnapshotStorage } from "@/storage/snapshots";
import { type RoiStorage } from "@/storage/roi";
import { type AlertStorage } from "@/alert/storage";
import { type DetectRuleStorage } from "@/detect-rule/storage";
import { type DetectRuleEngine } from "@/detect-rule/engine";
import { type StateStorage } from "@/state/storage";
import { type ThumbnailGenerator } from "@/storage/thumbnails";
import { type StorageCleaner } from "@/storage/cleaner";
import { type DiskUsage } from "@/storage/disk-usage";
import { type RecordingExporter } from "@/storage/export";
import { type AiDetector } from "@/ai/detector";
import { type PtzController } from "@/ptz";
import { type PreferencesStorage } from "@/storage/preferences";
import { type CrossLineStorage } from "@/storage/cross-lines";
import { type StorageFs } from "@/storage/storage-fs";
import { addCameraToConfig, removeCameraFromConfig, updateCameraInConfig, type AuthConfig } from "@/config";
import { checkAuth } from "@/auth";
import { getLogs } from "@/log-buffer";
import { realpath } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { spawn } from "node:child_process";

/** 异步执行 ffmpeg 并收集 stdout/stderr */
function runFfmpegAsync(ffmpegPath: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; stderr?: string }> {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => {
      proc.stdout?.destroy();
      proc.stderr?.destroy();
      proc.kill("SIGKILL");
      proc.unref();
      resolve({ ok: false, stderr });
    }, timeoutMs);
    proc.on("exit", (code) => { clearTimeout(timer); proc.unref(); resolve({ ok: code === 0, stderr }); });
    proc.on("error", () => { clearTimeout(timer); proc.unref(); resolve({ ok: false }); });
  });
}

/** 异步执行 ffmpeg 截帧，返回 JPEG Buffer */
function runFfmpegCapture(ffmpegPath: string, inputUrl: string, timeoutMs: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const args = ["-rtsp_transport", "tcp", "-i", inputUrl, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", "2", "-an", "pipe:1"];
    const proc = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    proc.stdout?.on("data", (chunk: Buffer) => { chunks.push(chunk); });
    const timer = setTimeout(() => {
      proc.stdout?.destroy();
      proc.kill("SIGKILL");
      proc.unref();
      resolve(null);
    }, timeoutMs);
    proc.on("exit", () => {
      clearTimeout(timer);
      proc.unref();
      const buf = Buffer.concat(chunks);
      resolve(buf.length > 100 ? buf : null);
    });
    proc.on("error", () => { clearTimeout(timer); proc.unref(); resolve(null); });
  });
}

/** WebSocket 客户端集合 */
type WsClient = import("bun").ServerWebSocket<{ type?: string; cameraId?: string }>;
const wsClients = new Set<WsClient>();

/** WebSocket 心跳检测：每 30 秒 ping，60 秒无 pong 关闭假死连接 */
const WS_PING_INTERVAL = 30_000;
const WS_PONG_TIMEOUT = 60_000;
const textEncoder = new TextEncoder();
/** 预分配心跳消息（避免每 30 秒重复 JSON.stringify） */
const WS_PING_MSG = JSON.stringify({ event: "ping" });
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
        ws.send(WS_PING_MSG);
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
const PUSH_EVENTS: EventName[] = ["frame", "motion", "detect", "camera:online", "camera:offline", "camera:lowfps", "alert", "detect:rule", "track:appeared", "track:disappeared", "track:label-updated", "track:enter-zone", "track:leave-zone", "track:dwell", "track:speed", "track:line-cross", "track:loiter", "track:approach", "track:match-suggest", "llm:scene", "state:changed"];

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
  crossLineStorage: CrossLineStorage,
  storageFs: StorageFs,
  alertSnapshotStorage?: SnapshotStorage,
  trajectoryStorage?: import("@/storage/track-trajectory").TrackTrajectoryStorage,
  multimodalAnalyzer?: import("@/ai/multimodal-analyzer").MultimodalAnalyzer,
  clipService?: import("@/ai/clip-service").ClipService,
  detectRuleStorage?: DetectRuleStorage,
  detectRuleEngine?: DetectRuleEngine,
  stateStorage?: StateStorage,
): void {
  /** 缓存 storageRoot 的 realpath（路径不变，避免每次请求重复解析） */
  let cachedStorageRoot: string | null = null;
  async function getStorageRoot(): Promise<string> {
    if (!cachedStorageRoot) {
      cachedStorageRoot = await realpath(recorder.getRecordingPath("."));
    }
    return cachedStorageRoot;
  }
  /** 缓存 recordings fs 的 storageRoot */
  let cachedRecFsRoot: string | null = null;
  async function getRecFsRoot(): Promise<string> {
    if (!cachedRecFsRoot) {
      cachedRecFsRoot = await realpath(storageFs.resolve("recordings"));
    }
    return cachedRecFsRoot;
  }

  /** 登录速率限制：IP → { count, resetAt }，内联清理 + 大小限制 */
  const loginRateLimits = new Map<string, { count: number; resetAt: number }>();
  const LOGIN_RATE_LIMIT_MAX = 1000;

  /** fMP4 流连接管理 */
  /** 每个摄像头的 fMP4 客户端集合（用于正确判断是否还有活跃连接） */
  const fmp4ClientsByCamera = new Map<string, Set<WsClient>>();
  /** 跟踪哪些摄像头有活跃的 fMP4 客户端（有 fMP4 客户端时不推送 JPEG 帧） */
  const fmp4ActiveCameras = new Set<string>();

  /** 全局 fMP4 分发器：只注册一次，按 cameraId 查找客户端集合发送（O(M) 而非 O(M*N)） */
  let fmp4GlobalDispatcherRegistered = false;
  function ensureFmp4GlobalDispatcher(bus: EventBus): void {
    if (fmp4GlobalDispatcherRegistered) return;
    fmp4GlobalDispatcherRegistered = true;

    bus.on("fmp4:init", (payload) => {
      const clientSet = fmp4ClientsByCamera.get(payload.cameraId);
      if (!clientSet || clientSet.size === 0) return;
      const encoded = getOrEncodeInit(payload.cameraId, payload.segment.codec, payload.segment.data);
      for (const client of clientSet) {
        client.send(encoded, false);
      }
    });

    bus.on("fmp4:segment", (payload) => {
      const clientSet = fmp4ClientsByCamera.get(payload.cameraId);
      if (!clientSet || clientSet.size === 0) return;
      encodeAndSendFmp4Media(payload.moofData, payload.mdatData, clientSet);
    });
  }

  /** 事件统计 API 缓存（10 秒 TTL） */
  const statsCache = new Map<string, { data: Record<string, unknown>; ts: number }>();

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
    const msg = Buffer.allocUnsafe(1 + 2 + codecBuf.length + data.length);
    msg[0] = FMP4_TYPE_INIT;
    msg.writeUInt16LE(codecBuf.length, 1);
    codecBuf.copy(msg, 3);
    data.copy(msg, 3 + codecBuf.length);
    return msg;
  }

  /** 封装 fMP4 media segment：直接拼接协议头 + moof + mdat，跳过 parser 层 concat2 的中间合并 */
  function encodeFmp4MediaFromParts(moofData: Buffer, mdatData: Buffer): Buffer {
    const msg = Buffer.allocUnsafe(1 + moofData.length + mdatData.length);
    msg[0] = FMP4_TYPE_MEDIA;
    moofData.copy(msg, 1);
    mdatData.copy(msg, 1 + moofData.length);
    return msg;
  }

  /** 缓存最近编码的 init segment（按摄像头分区） */
  const cachedInitByCamera = new Map<string, { dataPtr: Buffer; encoded: Buffer }>();

  function getOrEncodeInit(cameraId: string, codec: string, data: Buffer): Buffer {
    const cached = cachedInitByCamera.get(cameraId);
    if (cached && cached.dataPtr === data) return cached.encoded;
    const encoded = encodeFmp4Init(codec, data);
    cachedInitByCamera.set(cameraId, { dataPtr: data, encoded });
    return encoded;
  }

  function encodeAndSendFmp4Media(moofData: Buffer, mdatData: Buffer, clientSet: Set<WsClient>): void {
    /** 实时流每帧内容不同，跳过缓存命中检查，直接编码并广播 */
    const encoded = encodeFmp4MediaFromParts(moofData, mdatData);
    for (const client of clientSet) {
      /** 背压保护：缓冲区积压超过 2MB 时跳过（fMP4 允许更大缓冲，丢帧后 MSE 自动追赶到最新） */
      if (client.getBufferedAmount() > 2097152) continue;
      client.send(encoded, false);
    }
  }

  /** 封装已合并的 media segment（用于缓存首帧，无需拆分） */
  function encodeFmp4Media(data: Buffer): Buffer {
    const msg = Buffer.allocUnsafe(1 + data.length);
    msg[0] = FMP4_TYPE_MEDIA;
    data.copy(msg, 1);
    return msg;
  }

  function handleFmp4Connection(ws: WsClient, cameraId: string, camMgr: CameraManager, bus: EventBus) {
    const extractor = camMgr.getFmp4Extractor(cameraId);

    /** 没有 fMP4 提取器时直接关闭，让前端回退到 Canvas */
    if (!extractor) {
      console.warn(`[fMP4] 摄像头 ${cameraId} 没有 fMP4 流，关闭连接`);
      ws.close();
      return;
    }

    /** 注册全局分发器（只注册一次，所有客户端共享） */
    ensureFmp4GlobalDispatcher(bus);

    /** 发送缓存的 init segment（带协议头，关闭压缩） */
    if (extractor.initSegment) {
      ws.send(getOrEncodeInit(cameraId, extractor.initSegment.codec, extractor.initSegment.data), false);
    }

    /** 发送缓存的最近 media segment（立即显示画面，关闭压缩） */
    if (extractor.lastMediaSegment) {
      ws.send(encodeFmp4Media(extractor.lastMediaSegment), false);
    }

    fmp4ActiveCameras.add(cameraId);
    /** 注册到按摄像头分组的客户端集合（全局分发器直接发送） */
    let clientSet = fmp4ClientsByCamera.get(cameraId);
    if (!clientSet) {
      clientSet = new Set();
      fmp4ClientsByCamera.set(cameraId, clientSet);
    }
    clientSet.add(ws);
    console.log(`[fMP4] 客户端连接: ${cameraId}`);
  }

  function cleanupFmp4Connection(ws: WsClient) {
    const camId = (ws as unknown as { cameraId?: string }).cameraId;
    if (camId) {
      const clientSet = fmp4ClientsByCamera.get(camId);
      if (clientSet) {
        clientSet.delete(ws);
        /** 没有其他 fMP4 客户端连接同一摄像头 */
        if (clientSet.size === 0) {
          fmp4ClientsByCamera.delete(camId);
          fmp4ActiveCameras.delete(camId);
          cachedInitByCamera.delete(camId);
        }
      }
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
        /** 内联清理：每次登录时顺便清理过期条目，避免独立定时器 */
        if (loginRateLimits.size > LOGIN_RATE_LIMIT_MAX) {
          for (const [ip, b] of loginRateLimits) {
            if (now - b.resetAt > 120_000) loginRateLimits.delete(ip);
          }
        }
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
        return req.json().then(async (body: unknown) => {
          const obj = body as Record<string, unknown>;
          const id = obj.id as string | undefined;
          const friendlyName = obj.friendlyName as string | undefined;
          const hdUrl = obj.hdUrl as string | undefined;
          const sdUrl = obj.sdUrl as string | undefined;
          if (!id || !friendlyName || !hdUrl || !sdUrl) {
            return new Response("Missing required fields: id, friendlyName, hdUrl, sdUrl", { status: 400 });
          }
          const newConfig = await addCameraToConfig({ id, friendlyName, hdUrl, sdUrl, detectFps: obj.detectFps as number | undefined, group: obj.group as string | undefined });
          cameraManager.reloadConfig(newConfig);
          return Response.json({ ok: true, cameraId: id });
        }).catch(() => new Response("Invalid JSON", { status: 400 }));
      }

      /** 测试 RTSP 连接 */
      if (url.pathname === "/api/cameras/test" && req.method === "POST") {
        return req.json().then(async (body: unknown) => {
          const obj = body as Record<string, unknown>;
          const rtspUrl = obj.url as string | undefined;
          if (!rtspUrl) return new Response("Missing url", { status: 400 });
          const ffmpegPath = cameraManager.getFfmpegPath();
          const result = await runFfmpegAsync(ffmpegPath, [
            "-rtsp_transport", "tcp",
            "-i", rtspUrl,
            "-frames:v", "1",
            "-f", "null",
            "-",
          ], 8000);
          const match = result.stderr?.match(/Video: ([^\n]+)/);
          const videoInfo = match ? match[1] : undefined;
          return Response.json({ ok: result.ok, videoInfo, error: result.ok ? undefined : (result.stderr ?? "").slice(-200) });
        }).catch(() => new Response("Invalid JSON", { status: 400 }));
      }

      /** 更新 / 删除摄像头 */
      const cameraByIdMatch = url.pathname.match(/^\/api\/cameras\/([^/]+)$/);
      if (cameraByIdMatch) {
        const cameraId = cameraByIdMatch[1]!;

        if (req.method === "PATCH") {
          return req.json().then(async (body: unknown) => {
            const obj = body as Record<string, unknown>;
            const newConfig = await updateCameraInConfig(cameraId, {
              friendlyName: obj.friendlyName as string | undefined,
              hdUrl: obj.hdUrl as string | undefined,
              sdUrl: obj.sdUrl as string | undefined,
              group: obj.group as string | undefined,
            });
            cameraManager.reloadConfig(newConfig);
            return Response.json({ ok: true });
          }).catch(() => new Response("Invalid JSON", { status: 400 }));
        }

        if (req.method === "DELETE") {
          const newConfig = await removeCameraFromConfig(cameraId);
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

      /** 系统日志查询 */
      if (url.pathname === "/api/logs") {
        return Response.json(getLogs({
          level: url.searchParams.get("level") ?? undefined,
          tag: url.searchParams.get("tag") ?? undefined,
          limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 100,
        }));
      }

      /** 获取运行时设置 */
      if (url.pathname === "/api/settings" && req.method === "GET") {
        return Response.json(runtimeConfig.get());
      }

      /** 更新运行时设置 */
      if (url.pathname === "/api/settings" && req.method === "PATCH") {
        return req.json().then(async (body: unknown) => {
          const oldMode = runtimeConfig.get().recording.mode;
          const updated = runtimeConfig.patchFromJSON(body);
          /** 录像模式变更时通知 recorder */
          if (updated.recording.mode !== oldMode) {
            recorder.reloadMode();
          }
          /** 通知组件配置已更新 */
          if (multimodalAnalyzer) {
            multimodalAnalyzer.updateConfig(updated.ai.llm);
          }
          /** CLIP 模型/配置变更时重新加载（后台加载，不阻塞响应） */
          if (clipService) {
            clipService.updateConfig(updated.ai.clip).catch(err => {
              console.error("[API] CLIP 模型重新加载失败:", err);
            });
          }
          return Response.json(updated);
        }).catch(() => new Response("Invalid JSON", { status: 400 }));
      }

      /** 一键清除数据（事件、告警、快照、缩略图、追踪目标、轨迹、导出文件） */
      if (url.pathname === "/api/data/purge" && req.method === "POST") {
        return req.json().then(async (body: unknown) => {
          const opts = body as {
            events?: boolean;
            detectRules?: boolean;
            snapshots?: boolean;
            alertSnapshots?: boolean;
            thumbnails?: boolean;
            tracks?: boolean;
            trajectories?: boolean;
            exports?: boolean;
            recordings?: boolean;
          };
          const results: Record<string, string> = {};

          if (opts.events) {
            const count = eventStorage.purge(Date.now() + 1);
            results.events = `已删除 ${count} 条事件`;
          }
          if (opts.detectRules && detectRuleStorage) {
            const count = detectRuleStorage.purgeAll();
            results.detectRules = `已删除 ${count} 条检测记录`;
          }
          if (opts.snapshots) {
            const count = await snapshotStorage.purgeAll();
            results.snapshots = `已删除 ${count} 个检测快照`;
          }
          if (opts.alertSnapshots && alertSnapshotStorage) {
            const count = await alertSnapshotStorage.purgeAll();
            results.alertSnapshots = `已删除 ${count} 个告警快照`;
          }
          if (opts.thumbnails) {
            const count = await thumbnailGenerator.purgeAll();
            results.thumbnails = `已删除 ${count} 个缩略图`;
          }
          if (opts.tracks) {
            const count = trackStorage.purgeAll();
            results.tracks = `已删除 ${count} 个追踪目标`;
            trackLabelStorage.purgeAll();
            results.trackLabels = "已清除所有追踪命名";
          }
          if (opts.trajectories && trajectoryStorage) {
            const count = trajectoryStorage.purgeAll();
            results.trajectories = `已删除 ${count} 条轨迹`;
          }
          if (opts.exports) {
            const count = await exporter.purgeAll();
            results.exports = `已删除 ${count} 个导出文件`;
          }
          if (opts.recordings) {
            const count = await recorder.purgeAll();
            results.recordings = `已删除 ${count} 个录像文件`;
          }

          console.log(`[API] 一键清除: ${JSON.stringify(results)}`);
          return Response.json({ ok: true, results });
        }).catch(() => new Response("Invalid JSON", { status: 400 }));
      }

      /** 查询事件历史 */
      if (url.pathname === "/api/events/history") {
        const queryOpts = {
          type: url.searchParams.get("type") ?? undefined,
          typeLike: url.searchParams.get("typeLike") ?? undefined,
          cameraId: url.searchParams.get("cameraId") ?? undefined,
          since: url.searchParams.has("since") ? Number(url.searchParams.get("since")) : undefined,
          until: url.searchParams.has("until") ? Number(url.searchParams.get("until")) : undefined,
          limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 100,
          offset: url.searchParams.has("offset") ? Number(url.searchParams.get("offset")) : 0,
          search: url.searchParams.get("search") ?? undefined,
          starred: url.searchParams.get("starred") === "true" ? true : undefined,
          trackId: url.searchParams.has("trackId") ? Number(url.searchParams.get("trackId")) : undefined,
        };
        const { rows: rawEvents, total } = eventStorage.queryWithTotal(queryOpts);

        /**
         * 批量预加载快照路径和元数据，避免逐条异步 I/O
         * detect 事件用 detect 快照，alert/detect:rule 用告警快照
         */
        const detectEntries = rawEvents
          .filter(ev => ev.type === "detect")
          .map(ev => ({ cameraId: ev.camera_id, timestamp: ev.timestamp }));
        const detectSnapPaths = snapshotStorage.batchFindSnapshotPaths(detectEntries);

        const alertEntries = rawEvents
          .filter(ev => ev.type === "alert" || ev.type === "detect:rule")
          .map(ev => ({ cameraId: ev.camera_id, timestamp: ev.timestamp }));
        const alertSnapPaths = alertSnapshotStorage
          ? alertSnapshotStorage.batchFindSnapshotPaths(alertEntries)
          : new Map<string, string | null>();

        /** 批量加载需要 meta 的快照（去重） */
        const metaNeeded = [...detectSnapPaths.values()].filter((p): p is string => p != null);
        const metaMap = new Map<string, Awaited<ReturnType<typeof snapshotStorage.getSnapshotMeta>>>();
        if (metaNeeded.length > 0) {
          const uniquePaths = [...new Set(metaNeeded)];
          const metaResults = await Promise.all(uniquePaths.map(p => snapshotStorage.getSnapshotMeta(p).then(m => [p, m] as const)));
          for (const [p, m] of metaResults) metaMap.set(p, m);
        }

        /** 同步映射事件（无逐条 async，直接查预加载的数据） */
        const events = rawEvents.map(ev => {
          let summary: string | null = null;
          let snapshotUrl: string | null = null;
          let detections: unknown = null;

          if (ev.type === "detect" && ev.detail) {
            const snapPath = detectSnapPaths.get(`${ev.camera_id}:${ev.timestamp}`) ?? null;
            if (snapPath) {
              snapshotUrl = `/api/snapshots/${snapPath}`;
              const meta = metaMap.get(snapPath);
              if (meta?.detections) detections = meta.detections;
            }
            const detailObj = JSON.parse(ev.detail);
            if (detailObj?.labels && typeof detailObj.labels === "object") {
              summary = Object.entries(detailObj.labels as Record<string, number>).map(([l, c]) => c > 1 ? `${l} ×${c}` : l).join(", ");
            } else if (Array.isArray(detailObj?.detections)) {
              const labelCounts = new Map<string, number>();
              for (const d of detailObj.detections) {
                const name = d.trackName ?? d.label;
                labelCounts.set(name, (labelCounts.get(name) ?? 0) + 1);
              }
              summary = [...labelCounts.entries()].map(([l, c]) => c > 1 ? `${l} ×${c}` : l).join(", ");
            }
          } else if (ev.type === "alert" || ev.type === "detect:rule") {
            const snapPath = alertSnapPaths.get(`${ev.camera_id}:${ev.timestamp}`) ?? null;
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
          } else if (ev.type.startsWith("track:") && ev.detail) {
            const d = JSON.parse(ev.detail) as Record<string, unknown>;
            const parts: string[] = [];
            if (d.trackName) parts.push(String(d.trackName));
            else if (d.label) parts.push(String(d.label));
            if (d.zoneName) parts.push(String(d.zoneName));
            if (d.lineName) parts.push(String(d.lineName));
            if (typeof d.dwellMs === "number" && d.dwellMs > 0) parts.push(`${(d.dwellMs / 1000).toFixed(1)}s`);
            if (d.direction) parts.push(String(d.direction));
            if (parts.length > 0) summary = parts.join(" → ");
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

        const header = "id,type,camera_id,timestamp,track_id,track_name,label,zone_name,dwell_ms,speed,direction,starred";
        const rows = rawEvents.map(ev => {
          const ts = new Date(ev.timestamp).toISOString();
          /** 解析 detail JSON 提取结构化字段 */
          let trackId = "", trackName = "", label = "", zoneName = "", dwellMs = "", speed = "", direction = "";
          if (ev.detail) {
            const d = JSON.parse(ev.detail) as Record<string, unknown>;
            if (d.trackId != null) trackId = String(d.trackId);
            if (d.trackName) trackName = String(d.trackName);
            if (d.label) label = String(d.label);
            if (d.zoneName) zoneName = String(d.zoneName);
            if (d.lineName) zoneName = String(d.lineName);
            if (d.dwellMs != null) dwellMs = String(d.dwellMs);
            if (d.speed != null) speed = String(d.speed);
            if (d.direction) direction = String(d.direction);
          }
          return `${ev.id},${ev.type},${csvEscape(ev.camera_id)},${ts},${trackId},${csvEscape(trackName)},${csvEscape(label)},${csvEscape(zoneName)},${dwellMs},${speed},${csvEscape(direction)},${ev.starred ? 1 : 0}`;
        });
        const csv = [header, ...rows].join("\n");

        return new Response(csv, {
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="events_${new Date().toISOString().slice(0, 10)}.csv"`,
          },
        });
      }

      /** 事件统计（带 10 秒缓存，避免频繁轮询重复计算） */
      if (url.pathname === "/api/events/stats") {
        const since = url.searchParams.has("since") ? Number(url.searchParams.get("since")) : undefined;
        const until = url.searchParams.has("until") ? Number(url.searchParams.get("until")) : undefined;
        const cacheKey = `stats:${since ?? 0}:${until ?? 0}`;
        const cached = statsCache.get(cacheKey);
        if (cached && Date.now() - cached.ts < 10_000) return Response.json(cached.data);
        const opts = { since, until };
        const data = {
          byType: eventStorage.countByType(opts),
          byHour: eventStorage.countByHour(opts),
          byCamera: eventStorage.countByCamera(opts),
          byLabel: eventStorage.countByDetectionLabel(opts),
        };
        statsCache.set(cacheKey, { data, ts: Date.now() });
        /** 限制缓存大小，防止无限增长 */
        if (statsCache.size > 20) {
          const oldest = [...statsCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
          if (oldest) statsCache.delete(oldest[0]);
        }
        return Response.json(data);
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
                controller.enqueue(textEncoder.encode(header));
                controller.enqueue(payload.data);
                controller.enqueue(textEncoder.encode("\r\n"));
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
              controller.enqueue(textEncoder.encode(initHeader));
              controller.enqueue(frame);
              controller.enqueue(textEncoder.encode("\r\n"));
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
          /** 从主码流拉取高清帧（使用内存中的配置，避免 readFileSync） */
          const cam = cameraManager.getCameraConfig(cameraId);
          if (!cam) return new Response("Camera not found", { status: 404 });
          const ffmpegPath = cameraManager.getFfmpegPath();
          const result = await runFfmpegCapture(ffmpegPath, cam.stream.hd, 5000);
          if (!result) {
            return new Response("HD capture failed", { status: 504 });
          }
          return new Response(result, {
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

        /** 搜索 detect 事件的 detail 中包含该 label 或 trackName 的记录 */
        const escapedLabel = label.replace(/"/g, '\\"');
        const events = eventStorage.query({
          type: "detect",
          cameraId,
          since,
          until,
          search: `"${escapedLabel}"`,
          limit: 500,
        });

        /** 按 cameraId + timestamp 映射到录像文件 */
        const matchedCameraIds = new Set(events.map(e => e.camera_id));
        const result: Array<{ filename: string; cameraId: string; startTime: number; endTime: number; size: number; matchCount: number; matchTimestamps: number[] }> = [];
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
              result.push({ ...rec, matchCount: matchEvents.length, matchTimestamps: matchEvents.map(e => e.timestamp) });
            }
          }
        }
        result.sort((a, b) => b.startTime - a.startTime);
        return Response.json(result);
      }

      /** 语义化录像搜索：用自然语言描述查找录像片段 */
      if (url.pathname === "/api/recordings/semantic-search" && req.method === "GET") {
        const query = url.searchParams.get("q") ?? "";
        const cameraId = url.searchParams.get("cameraId") ?? undefined;
        const since = url.searchParams.has("since") ? Number(url.searchParams.get("since")) : undefined;
        const until = url.searchParams.has("until") ? Number(url.searchParams.get("until")) : undefined;
        /** 最大返回匹配目标数 */
        const topK = Math.min(Number(url.searchParams.get("topK") ?? 10), 20);

        if (!query) return Response.json({ error: "q is required" }, { status: 400 });
        if (!clipService) return Response.json({ error: "CLIP service not available" }, { status: 503 });

        /** 1. 获取查询文本的 CLIP 嵌入 */
        const embedResult = await clipService.textEmbed([query]);
        const queryEmbedding = embedResult.embeddings[0];
        if (!queryEmbedding?.length) {
          return Response.json({ error: "Failed to compute text embedding" }, { status: 500 });
        }

        /** 2. 遍历所有有 CLIP embedding 的 track，计算余弦相似度 */
        const candidates: Array<{ trackId: number; label: string; customName?: string; semanticLabel?: string; cameraIds: string[]; similarity: number }> = [];
        for (const track of trackStorage.listTracks()) {
          const record = trackStorage.getRecord(track.trackId);
          if (!record?.clipEmbedding?.length) continue;
          /** 余弦距离 → 相似度 */
          const dist = TrackStorage.clipEmbeddingDistance(queryEmbedding, record.clipEmbedding);
          const similarity = 1 - dist;
          if (similarity > 0.2) {
            candidates.push({
              trackId: track.trackId,
              label: track.label,
              customName: record.customName,
              semanticLabel: record.semanticLabel,
              cameraIds: track.cameraIds,
              similarity,
            });
          }
        }
        candidates.sort((a, b) => b.similarity - a.similarity);
        const topMatches = candidates.slice(0, topK);

        /** 3. 匹配的 trackId → 查事件表获取时间戳 → 映射到录像文件 */
        const allEvents: Array<{ camera_id: string; timestamp: number; trackId: number }> = [];
        for (const match of topMatches) {
          const events = eventStorage.query({
            typeLike: "track:%",
            cameraId,
            since,
            until,
            trackId: match.trackId,
            limit: 200,
          });
          for (const e of events) {
            allEvents.push({ camera_id: e.camera_id, timestamp: e.timestamp, trackId: match.trackId });
          }
        }

        /** 按 cameraId 分组映射到录像 */
        const cameraEvents = new Map<string, Array<{ timestamp: number; trackId: number }>>();
        for (const e of allEvents) {
          let arr = cameraEvents.get(e.camera_id);
          if (!arr) { arr = []; cameraEvents.set(e.camera_id, arr); }
          arr.push({ timestamp: e.timestamp, trackId: e.trackId });
        }

        const result: Array<{
          filename: string;
          cameraId: string;
          startTime: number;
          endTime: number;
          size: number;
          matchCount: number;
          matches: Array<{ trackId: number; label: string; customName?: string; semanticLabel?: string; similarity: number }>;
        }> = [];
        for (const [camId, events] of cameraEvents) {
          const minTs = Math.min(...events.map(e => e.timestamp));
          const maxTs = Math.max(...events.map(e => e.timestamp));
          const recs = recorder.listRecordings(camId, since ?? minTs - 60000, until ?? maxTs + 60000);
          for (const rec of recs) {
            const matchEvents = events.filter(e => e.timestamp >= rec.startTime && e.timestamp <= rec.endTime);
            if (matchEvents.length === 0) continue;
            /** 合并匹配目标信息（去重） */
            const matchTrackIds = new Set(matchEvents.map(e => e.trackId));
            const matches = topMatches.filter(m => matchTrackIds.has(m.trackId));
            result.push({ ...rec, matchCount: matchEvents.length, matches });
          }
        }
        result.sort((a, b) => b.startTime - a.startTime);

        return Response.json({ query, totalTracks: candidates.length, results: result });
      }

      /** 录像文件播放（支持 Range 请求，MP4 seek 必需） */
      const recordingMatch = url.pathname.match(/^\/api\/recordings\/([^/]+)\/(.+\.mp4)$/);
      if (recordingMatch && req.method === "GET") {
        const camId = recordingMatch[1]!;
        const filename = recordingMatch[2]!;
        const filePath = recorder.getRecordingPath(`${camId}/${filename}`);
        const file = Bun.file(filePath);
        const fileSize = await file.size;
        if (fileSize === undefined) return new Response("Not Found", { status: 404 });
        /** 异步路径遍历防护 */
        const storageRoot = await getStorageRoot();
        const resolved = await realpath(filePath);
        if (!resolved.startsWith(storageRoot)) return new Response("Forbidden", { status: 403 });

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
        if ((await Bun.file(filePath).size) === undefined) return new Response("Not Found", { status: 404 });
        /** 路径遍历防护 */
        const storageRoot = await getRecFsRoot();
        const resolved = await realpath(filePath);
        if (!resolved.startsWith(storageRoot)) return new Response("Forbidden", { status: 403 });
        await storageFs.deleteFile(relPath, { category: "recordings" });
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
          if ((await Bun.file(snapFilePath).size) !== undefined) {
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
        if ((await Bun.file(videoPath).size) === undefined) return new Response("Not Found", { status: 404 });

        /** 防止路径遍历 */
        const storageRoot = await getStorageRoot();
        const resolved = await realpath(videoPath);
        if (!resolved.startsWith(storageRoot)) return new Response("Forbidden", { status: 403 });

        const thumbPath = await thumbnailGenerator.getOrCreateAsync(resolved, timeSec);
        if (!thumbPath) return new Response("Thumbnail generation failed", { status: 500 });

        const file = Bun.file(thumbPath);
        return new Response(file, {
          headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" },
        });
      }

      /** 批量预生成缩略图 */
      if (url.pathname === "/api/recordings/thumb-preload" && req.method === "POST") {
        return req.json().then(async (body: unknown) => {
          const obj = body as Record<string, unknown>
          const files = obj.files as Array<{ filename: string; durationSec: number }> | undefined
          if (!files || !Array.isArray(files)) return new Response("Invalid body", { status: 400 })

          const storageRoot = await getStorageRoot()
          const tasks: Array<{ path: string; durationSec: number }> = []
          for (const f of files) {
            const videoPath = recorder.getRecordingPath(f.filename)
            if ((await Bun.file(videoPath).size) === undefined) continue
            const resolved = await realpath(videoPath)
            if (!resolved.startsWith(storageRoot)) continue
            tasks.push({ path: resolved, durationSec: f.durationSec })
          }
          /** 后台异步生成，不阻塞响应 */
          thumbnailGenerator.pregenerateAsync(tasks).catch(() => {})
          return Response.json({ queued: tasks.length })
        })
      }

      /** 批量删除录像 */
      if (url.pathname === "/api/recordings/batch-delete" && req.method === "POST") {
        return req.json().then(async (body: unknown) => {
          const obj = body as Record<string, unknown>;
          const files = obj.files;
          if (!Array.isArray(files)) return Response.json({ error: "files required" }, { status: 400 });
          const storageRoot = await getRecFsRoot();
          let deleted = 0;
          let failed = 0;
          for (const relPath of files) {
            if (typeof relPath !== "string") { failed++; continue; }
            /** 路径遍历防护 */
            if (relPath.includes("..")) { failed++; continue; }
            const filePath = storageFs.resolve(`recordings/${relPath}`);
            const resolved = await realpath(filePath).catch(() => "");
            if (!resolved.startsWith(storageRoot)) { failed++; continue; }
            if ((await Bun.file(filePath).size) === undefined) { failed++; continue; }
            storageFs.deleteFile(`recordings/${relPath}`, { category: "recordings" });
            deleted++;
          }
          return Response.json({ deleted, failed });
        });
      }

      /** 删除指定时间之前的所有录像 */
      if (url.pathname === "/api/recordings/purge-before" && req.method === "POST") {
        return req.json().then(async (body: unknown) => {
          const obj = body as Record<string, unknown>;
          const before = obj.before as number | undefined;
          const cameraId = obj.cameraId as string | undefined;
          if (!before) return Response.json({ error: "before timestamp required" }, { status: 400 });
          const allRecordings = recorder.listRecordings(cameraId || undefined);
          const toDelete = allRecordings.filter(r => r.startTime < before);
          let deleted = 0;
          for (const rec of toDelete) {
            await storageFs.deleteFile(`recordings/${rec.filename}`, { category: "recordings" });
            deleted++;
          }
          console.log(`[API] 删除 ${deleted} 个旧录像 (before ${new Date(before).toISOString()})`);
          return Response.json({ deleted, total: allRecordings.length });
        });
      }

      /** 录像导出：裁剪视频片段 */
      if (url.pathname === "/api/recordings/export" && req.method === "POST") {
        return req.json().then(async (body: unknown) => {
          const obj = body as Record<string, unknown>;
          const file = obj.file as string | undefined;
          const startSec = obj.startSec as number | undefined;
          const endSec = obj.endSec as number | undefined;
          const cameraId = obj.cameraId as string | undefined;
          if (!file || startSec === undefined || endSec === undefined) {
            return new Response("Missing file, startSec, endSec", { status: 400 });
          }

          const videoPath = recorder.getRecordingPath(file);
          if ((await Bun.file(videoPath).size) === undefined) return new Response("Not Found", { status: 404 });

          /** 防止路径遍历 */
          const storageRoot = await getStorageRoot();
          const resolved = await realpath(videoPath);
          if (!resolved.startsWith(storageRoot)) return new Response("Forbidden", { status: 403 });

          const result = await exporter.exportAsync(resolved, startSec, endSec, cameraId ?? "unknown");
          if (!result) return new Response("Export failed", { status: 500 });

          const exportFilename = result.filePath.split("/").pop()!;
          return Response.json({ filename: exportFilename, size: result.size });
        }).catch(() => new Response("Invalid JSON", { status: 400 }));
      }

      /** 录像合并导出：合并多个录像文件 */
      if (url.pathname === "/api/recordings/merge" && req.method === "POST") {
        return req.json().then(async (body: unknown) => {
          const obj = body as Record<string, unknown>;
          const files = obj.files as string[] | undefined;
          const cameraId = obj.cameraId as string | undefined;
          if (!files || !Array.isArray(files) || files.length === 0) {
            return new Response("Missing files array", { status: 400 });
          }

          /** 防止路径遍历：验证所有文件 */
          const storageRoot = await getStorageRoot();
          const resolvedPaths: string[] = [];
          for (const relPath of files) {
            const videoPath = recorder.getRecordingPath(relPath);
            if ((await Bun.file(videoPath).size) === undefined) return new Response(`Not Found: ${relPath}`, { status: 404 });
            const resolved = await realpath(videoPath);
            if (!resolved.startsWith(storageRoot)) return new Response("Forbidden", { status: 403 });
            resolvedPaths.push(resolved);
          }

          const result = await exporter.mergeAsync(resolvedPaths, cameraId ?? "unknown");
          if (!result) return new Response("Merge failed", { status: 500 });

          const exportFilename = result.filePath.split("/").pop()!;
          return Response.json({ filename: exportFilename, size: result.size });
        }).catch(() => new Response("Invalid JSON", { status: 400 }));
      }

      /** GIF 导出：将视频片段转为 GIF 动图 */
      if (url.pathname === "/api/recordings/gif" && req.method === "POST") {
        return req.json().then(async (body: unknown) => {
          const obj = body as Record<string, unknown>;
          const file = obj.file as string | undefined;
          const startSec = obj.startSec as number | undefined;
          const endSec = obj.endSec as number | undefined;
          const cameraId = obj.cameraId as string | undefined;
          if (!file || startSec === undefined || endSec === undefined) {
            return new Response("Missing file, startSec, endSec", { status: 400 });
          }

          const videoPath = recorder.getRecordingPath(file);
          if ((await Bun.file(videoPath).size) === undefined) return new Response("Not Found", { status: 404 });

          const storageRoot = await getStorageRoot();
          const resolved = await realpath(videoPath);
          if (!resolved.startsWith(storageRoot)) return new Response("Forbidden", { status: 403 });

          const result = await exporter.toGifAsync(resolved, startSec, endSec, cameraId ?? "unknown");
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
          const storageRoot = await getStorageRoot();
          const resolvedPaths: string[] = [];
          for (const relPath of files) {
            const videoPath = recorder.getRecordingPath(relPath);
            if ((await Bun.file(videoPath).size) === undefined) return new Response(`Not Found: ${relPath}`, { status: 404 });
            const resolved = await realpath(videoPath);
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
        const exportRoot = await realpath(exporter.getExportPath("."));
        const filePath = exporter.getExportPath(filename);
        if ((await Bun.file(filePath).size) === undefined) return new Response("Not Found", { status: 404 });
        const resolved = await realpath(filePath);
        if (!resolved.startsWith(exportRoot)) return new Response("Forbidden", { status: 403 });

        const fileSize = await Bun.file(filePath).size;
        const file = Bun.file(filePath);
        const contentType = filename.endsWith(".gif") ? "image/gif" : filename.endsWith(".zip") ? "application/zip" : "video/mp4";
        return new Response(file, {
          headers: {
            "Content-Type": contentType,
            "Content-Length": String(fileSize),
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
        if ((await Bun.file(filePath).size) === undefined) return new Response("Not Found", { status: 404 });
        /** 防止路径遍历 */
        const snapRoot = await realpath(snapshotStorage.getSnapshotPath("."));
        const resolved = await realpath(filePath);
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
        const meta = await snapshotStorage.getSnapshotMeta(`${camId}/${filename}`);
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
        if ((await Bun.file(filePath).size) === undefined) return new Response("Not Found", { status: 404 });
        const snapRoot = await realpath(alertSnapshotStorage.getSnapshotPath("."));
        const resolved = await realpath(filePath);
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

      /** 区域统计（按摄像头聚合所有区域事件） */
      const roiStatsMatch = url.pathname.match(/^\/api\/roi\/stats\/([^/]+)$/);
      if (roiStatsMatch && req.method === "GET") {
        const cameraId = roiStatsMatch[1]!;
        const since = url.searchParams.has("since") ? Number(url.searchParams.get("since")) : undefined;
        const until = url.searchParams.has("until") ? Number(url.searchParams.get("until")) : undefined;
        return Response.json(eventStorage.zoneStats({ cameraId, since, until }));
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

      /** ====== 越线检测线段 API ====== */

      /** 越线检测线段列表（全部） */
      if (url.pathname === "/api/cross-lines" && req.method === "GET") {
        return Response.json(crossLineStorage.listAll());
      }

      /** 越线检测线段列表（按摄像头） */
      const crossLineListMatch = url.pathname.match(/^\/api\/cross-lines\/([^/]+)$/);
      if (crossLineListMatch && req.method === "GET" && !crossLineListMatch[1]!.match(/^\d+$/)) {
        const cameraId = crossLineListMatch[1]!;
        return Response.json(crossLineStorage.list(cameraId));
      }

      /** 越线检测线段添加 */
      if (url.pathname === "/api/cross-lines" && req.method === "POST") {
        return req.json().then((body: unknown) => {
          const obj = body as Record<string, unknown>;
          const cameraId = obj.cameraId as string | undefined;
          const name = obj.name as string | undefined;
          const start = obj.start as { x: number; y: number } | undefined;
          const end = obj.end as { x: number; y: number } | undefined;
          if (!cameraId || !start || !end) return new Response("Missing cameraId, start, or end", { status: 400 });
          const id = crossLineStorage.add(cameraId, name ?? "", start, end);
          return Response.json({ id });
        }).catch(() => new Response("Invalid JSON", { status: 400 }));
      }

      /** 越线检测线段更新/删除 */
      const crossLineItemMatch = url.pathname.match(/^\/api\/cross-lines\/(\d+)$/);
      if (crossLineItemMatch) {
        const lineId = Number(crossLineItemMatch[1]!);
        if (req.method === "PATCH") {
          return req.json().then((body: unknown) => {
            const obj = body as Record<string, unknown>;
            const updates: { name?: string; start?: { x: number; y: number }; end?: { x: number; y: number }; enabled?: boolean } = {};
            if (typeof obj.name === "string") updates.name = obj.name;
            if (obj.start && typeof obj.start === "object") updates.start = obj.start as { x: number; y: number };
            if (obj.end && typeof obj.end === "object") updates.end = obj.end as { x: number; y: number };
            if (typeof obj.enabled === "boolean") updates.enabled = obj.enabled;
            crossLineStorage.update(lineId, updates);
            return Response.json({ ok: true });
          }).catch(() => new Response("Invalid JSON", { status: 400 }));
        }
        if (req.method === "DELETE") {
          crossLineStorage.remove(lineId);
          return Response.json({ ok: true });
        }
      }

      /** 检测规则列表 */
      if (url.pathname === "/api/detect-rules" && req.method === "GET" && detectRuleStorage) {
        return Response.json(detectRuleStorage.listRules());
      }

      /** 添加检测规则 */
      if (url.pathname === "/api/detect-rules" && req.method === "POST" && detectRuleStorage) {
        return req.json().then((body: unknown) => {
          const obj = body as Record<string, unknown>;
          const name = obj.name as string | undefined;
          const cameraId = obj.cameraId as string | undefined;
          const prompt = obj.prompt as string | undefined;
          if (!name || !cameraId || !prompt) return new Response("Missing name, cameraId or prompt", { status: 400 });
          const id = detectRuleStorage.addRule({
            name,
            cameraId,
            roiId: (obj.roiId as number) ?? 0,
            prompt,
            intervalMs: (obj.intervalMs as number) ?? 5000,
            cooldownMs: (obj.cooldownMs as number) ?? 30000,
            imageWidth: (obj.imageWidth as number) ?? 0,
            stateIds: (obj.stateIds as number[]) ?? [],
            schedule: (obj.schedule as string) ?? "",
            saveOriginal: (obj.saveOriginal as boolean) ?? true,
          });
          detectRuleEngine?.reloadRules();
          return Response.json({ id });
        }).catch(() => new Response("Invalid JSON", { status: 400 }));
      }

      /** 更新检测规则 */
      const detectRuleMatch = url.pathname.match(/^\/api\/detect-rules\/(\d+)$/);
      if (detectRuleMatch && req.method === "PATCH" && detectRuleStorage) {
        const ruleId = Number(detectRuleMatch[1]!);
        return req.json().then((body: unknown) => {
          const obj = body as Record<string, unknown>;
          const updates: Record<string, unknown> = {};
          for (const key of ["name", "cameraId", "roiId", "prompt", "intervalMs", "cooldownMs", "enabled", "imageWidth", "stateIds", "schedule", "saveOriginal"] as const) {
            if (obj[key] !== undefined) updates[key] = obj[key];
          }
          detectRuleStorage.updateRule(ruleId, updates as never);
          detectRuleEngine?.reloadRules();
          return Response.json({ ok: true });
        }).catch(() => new Response("Invalid JSON", { status: 400 }));
      }

      /** 删除检测规则 */
      if (detectRuleMatch && req.method === "DELETE" && detectRuleStorage) {
        const ruleId = Number(detectRuleMatch[1]!);
        detectRuleStorage.removeRule(ruleId);
        detectRuleEngine?.reloadRules();
        return Response.json({ ok: true });
      }

      /** 检测规则历史记录 */
      if (url.pathname === "/api/detect-rules/history" && detectRuleStorage) {
        const records = detectRuleStorage.queryRecords({
          cameraId: url.searchParams.get("cameraId") ?? undefined,
          since: url.searchParams.has("since") ? Number(url.searchParams.get("since")) : undefined,
          until: url.searchParams.has("until") ? Number(url.searchParams.get("until")) : undefined,
          matched: url.searchParams.has("matched") ? url.searchParams.get("matched") === "1" : undefined,
          limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 50,
          offset: url.searchParams.has("offset") ? Number(url.searchParams.get("offset")) : 0,
        });
        const total = detectRuleStorage.countRecords({
          cameraId: url.searchParams.get("cameraId") ?? undefined,
          since: url.searchParams.has("since") ? Number(url.searchParams.get("since")) : undefined,
          until: url.searchParams.has("until") ? Number(url.searchParams.get("until")) : undefined,
          matched: url.searchParams.has("matched") ? url.searchParams.get("matched") === "1" : undefined,
        });
        return Response.json({ records, total });
      }

      // ===== 告警规则 API =====

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
            windowSeconds: (obj.windowSeconds as number) ?? 60,
            threshold: (obj.threshold as number) ?? 3,
            cooldownSeconds: (obj.cooldownSeconds as number) ?? 300,
            silentStart: (obj.silentStart as string) ?? "",
            silentEnd: (obj.silentEnd as string) ?? "",
            sourceRuleId: (obj.sourceRuleId as number) ?? 0,
            sourceStateId: (obj.sourceStateId as number) ?? 0,
            condition: (obj.condition as string) ?? "",
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
          for (const key of ["name", "eventType", "cameraId", "windowSeconds", "threshold", "cooldownSeconds", "enabled", "silentStart", "silentEnd", "sourceRuleId", "sourceStateId", "condition"] as const) {
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

      /** 告警历史记录 */
      if (url.pathname === "/api/alerts/history" && req.method === "GET") {
        const { records, total } = alertStorage.queryAlerts({
          cameraId: url.searchParams.get("cameraId") ?? undefined,
          since: url.searchParams.has("since") ? Number(url.searchParams.get("since")) : undefined,
          until: url.searchParams.has("until") ? Number(url.searchParams.get("until")) : undefined,
          limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 50,
          offset: url.searchParams.has("offset") ? Number(url.searchParams.get("offset")) : 0,
        });
        return Response.json({ records, total });
      }

      // ===== 状态管理 API =====

      /** 列出所有状态 */
      if (url.pathname === "/api/states" && req.method === "GET" && stateStorage) {
        return Response.json(stateStorage.listStates());
      }

      /** 创建状态 */
      if (url.pathname === "/api/states" && req.method === "POST" && stateStorage) {
        return req.json().then((body: unknown) => {
          const obj = body as Record<string, unknown>;
          const name = obj.name as string | undefined;
          if (!name) return new Response("Missing name", { status: 400 });
          const id = stateStorage.addState({
            name,
            description: (obj.description as string) ?? "",
            cameraId: (obj.cameraId as string) ?? "",
            valueType: (obj.valueType as "boolean" | "string" | "number") ?? "boolean",
            initialValue: (obj.initialValue as string) ?? "",
            notifyOnChange: (obj.notifyOnChange as boolean) ?? false,
            enabled: (obj.enabled as boolean) ?? true,
          });
          return Response.json({ id });
        }).catch(() => new Response("Invalid JSON", { status: 400 }));
      }

      /** 更新状态定义 */
      const stateMatch = url.pathname.match(/^\/api\/states\/(\d+)$/);
      if (stateMatch && req.method === "PATCH" && stateStorage) {
        const stateId = Number(stateMatch[1]!);
        return req.json().then((body: unknown) => {
          const obj = body as Record<string, unknown>;
          stateStorage.updateState(stateId, obj as never);
          return Response.json({ ok: true });
        }).catch(() => new Response("Invalid JSON", { status: 400 }));
      }

      /** 删除状态 */
      if (stateMatch && req.method === "DELETE" && stateStorage) {
        const stateId = Number(stateMatch[1]!);
        stateStorage.removeState(stateId);
        return Response.json({ ok: true });
      }

      /** 手动设置状态值 */
      const stateValueMatch = url.pathname.match(/^\/api\/states\/(\d+)\/value$/);
      if (stateValueMatch && req.method === "PATCH" && stateStorage) {
        const stateId = Number(stateValueMatch[1]!);
        return req.json().then((body: unknown) => {
          const obj = body as Record<string, unknown>;
          const newValue = obj.value as string | undefined;
          if (newValue === undefined) return new Response("Missing value", { status: 400 });
          const change = stateStorage.setValue(stateId, newValue, "manual", 0);
          if (change) {
            const stateDef = stateStorage.getState(stateId);
            eventBus.emit("state:changed", {
              stateId: change.stateId,
              stateName: change.stateName,
              cameraId: change.cameraId,
              oldValue: change.oldValue,
              newValue: change.newValue,
              source: "manual",
              sourceRuleId: 0,
              timestamp: change.timestamp,
              notify: stateDef?.notifyOnChange ?? false,
            });
          }
          return Response.json({ changed: !!change });
        }).catch(() => new Response("Invalid JSON", { status: 400 }));
      }

      /** 状态变更历史 */
      if (url.pathname === "/api/states/history" && stateStorage) {
        const records = stateStorage.queryChanges({
          stateId: url.searchParams.has("stateId") ? Number(url.searchParams.get("stateId")) : undefined,
          cameraId: url.searchParams.get("cameraId") ?? undefined,
          since: url.searchParams.has("since") ? Number(url.searchParams.get("since")) : undefined,
          until: url.searchParams.has("until") ? Number(url.searchParams.get("until")) : undefined,
          limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 50,
          offset: url.searchParams.has("offset") ? Number(url.searchParams.get("offset")) : 0,
        });
        const total = stateStorage.countChanges({
          stateId: url.searchParams.has("stateId") ? Number(url.searchParams.get("stateId")) : undefined,
          cameraId: url.searchParams.get("cameraId") ?? undefined,
          since: url.searchParams.has("since") ? Number(url.searchParams.get("since")) : undefined,
          until: url.searchParams.has("until") ? Number(url.searchParams.get("until")) : undefined,
        });
        return Response.json({ records, total });
      }

      /** 存储清理状态 */
      if (url.pathname === "/api/cleanup/stats" && req.method === "GET") {
        return Response.json(cleaner.getStats());
      }

      /** 手动触发清理 */
      if (url.pathname === "/api/cleanup/run" && req.method === "POST") {
        const report = await cleaner.runCleanup();
        return Response.json(report);
      }

      /** 获取当前 AI 模型信息 */
      if (url.pathname === "/api/ai/model" && req.method === "GET") {
        return Response.json(aiDetector.getModelInfo());
      }

      /** 重新加载 AI 模型（VLM 模式下为空操作，保留 API 兼容） */
      if (url.pathname === "/api/ai/reload-model" && req.method === "POST") {
        const result = await aiDetector.reloadModel();
        return Response.json(result);
      }

      // ===== PTZ 云台控制（统一 regex 匹配，单次提取 cameraId + action） =====
      const ptzMatch = url.pathname.match(/^\/api\/ptz\/([^/]+)\/([a-z-]+)$/);
      if (ptzMatch) {
        const cameraId = decodeURIComponent(ptzMatch[1]!);
        const action = ptzMatch[2]!;

        if (action === "status" && req.method === "GET") {
          const supported = ptzController.hasPtz(cameraId);
          if (!supported) return Response.json({ supported: false });
          return ptzController.getStatus(cameraId)
            .then(pos => Response.json({ supported: true, position: pos }))
            .catch(err => Response.json({ error: String(err) }, { status: 500 }));
        }

        if (action === "move" && req.method === "POST") {
          return req.json().then((body: unknown) => {
            const obj = body as Record<string, unknown>;
            const vel = obj.velocity as { x?: number; y?: number; zoom?: number } | undefined;
            const timeout = (obj.timeout as number) ?? 0;
            /** fire-and-forget：不等待设备响应，消除 50-200ms 延迟感知 */
            ptzController.continuousMove(cameraId, vel ?? {}, timeout).catch(err => console.error(`[PTZ] move error:`, err));
            return Response.json({ ok: true });
          }).catch(err => Response.json({ error: String(err) }, { status: 500 }));
        }

        if (action === "stop" && req.method === "POST") {
          ptzController.stop(cameraId).catch(err => console.error(`[PTZ] stop error:`, err));
          return Response.json({ ok: true });
        }

        if (action === "absolute" && req.method === "POST") {
          return req.json().then((body: unknown) => {
            const obj = body as Record<string, unknown>;
            ptzController.absoluteMove(cameraId, obj.position as { x?: number; y?: number; zoom?: number })
              .catch(err => console.error(`[PTZ] absolute error:`, err));
            return Response.json({ ok: true });
          }).catch(err => Response.json({ error: String(err) }, { status: 500 }));
        }

        if (action === "relative" && req.method === "POST") {
          return req.json().then((body: unknown) => {
            const obj = body as Record<string, unknown>;
            ptzController.relativeMove(cameraId, obj.delta as { x?: number; y?: number; zoom?: number })
              .catch(err => console.error(`[PTZ] relative error:`, err));
            return Response.json({ ok: true });
          }).catch(err => Response.json({ error: String(err) }, { status: 500 }));
        }

        if (action === "presets" && req.method === "GET") {
          return ptzController.getPresets(cameraId)
            .then(presets => Response.json({ presets }))
            .catch(err => Response.json({ error: String(err) }, { status: 500 }));
        }

        if (action === "goto-preset" && req.method === "POST") {
          return req.json().then((body: unknown) => {
            const obj = body as Record<string, unknown>;
            ptzController.gotoPreset(cameraId, obj.presetToken as string)
              .catch(err => console.error(`[PTZ] goto-preset error:`, err));
            return Response.json({ ok: true });
          }).catch(err => Response.json({ error: String(err) }, { status: 500 }));
        }

        if (action === "set-preset" && req.method === "POST") {
          return req.json().then(async (body: unknown) => {
            const obj = body as Record<string, unknown>;
            const token = await ptzController.setPreset(cameraId, obj.presetName as string);
            return Response.json({ ok: true, presetToken: token });
          }).catch(err => Response.json({ error: String(err) }, { status: 500 }));
        }

        if (action === "remove-preset" && req.method === "POST") {
          return req.json().then(async (body: unknown) => {
            const obj = body as Record<string, unknown>;
            await ptzController.removePreset(cameraId, obj.presetToken as string);
            return Response.json({ ok: true });
          }).catch(err => Response.json({ error: String(err) }, { status: 500 }));
        }

        if (action === "home" && req.method === "POST") {
          ptzController.gotoHomePosition(cameraId)
            .catch(err => console.error(`[PTZ] home error:`, err));
          return Response.json({ ok: true });
        }
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

      /** 手动全量校准磁盘用量 + 文件索引（用户主动触发） */
      if (url.pathname === "/api/storage/calibrate" && req.method === "POST") {
        const dataDir = storageFs.root;
        await Promise.all([
          diskUsage.calibrateAsync(),
          storageFs.fileIndex.calibrate("recordings", join(dataDir, "recordings"), (relPath: string) => {
            const parts = relPath.split("/");
            return { cameraId: parts.length >= 2 ? parts[0] : undefined };
          }),
          storageFs.fileIndex.calibrate("snapshots", join(dataDir, "detection-snapshots"), (relPath: string) => {
            const parts = relPath.split("/");
            return { cameraId: parts.length >= 2 ? parts[0] : undefined };
          }),
          storageFs.fileIndex.calibrate("exports", join(dataDir, "exports"), () => ({})),
          storageFs.fileIndex.calibrate("thumbnails", join(dataDir, "thumbnails"), () => ({})),
          storageFs.fileIndex.calibrate("alert-snapshots", join(dataDir, "alert-snapshots"), (relPath: string) => {
            const parts = relPath.split("/");
            return { cameraId: parts.length >= 2 ? parts[0] : undefined };
          }),
        ]);
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
          /** 命名后反向关联外观相似的未命名目标 */
          aiDetector.propagateName(body.trackId, body.name, body.cameraId);
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
        const parts = url.pathname.split("/");
        /** 支持两种格式: /api/track-labels/:id 或 /api/track-labels/:cameraId/:trackId */
        if (parts.length === 5) {
          const id = parseInt(parts[4] ?? "");
          if (!id) return Response.json({ error: "invalid id" }, { status: 400 });
          const ok = trackLabelStorage.remove(id);
          return Response.json({ ok });
        }
        if (parts.length === 6) {
          const cameraId = parts[4];
          const trackId = parseInt(parts[5] ?? "");
          if (!cameraId || !trackId) return Response.json({ error: "invalid params" }, { status: 400 });
          const ok = trackLabelStorage.removeByTrack(cameraId, trackId);
          if (ok) {
            /** 同步清除 TrackStorage 的 customName */
            trackStorage.setCustomName(trackId, "");
            /** 广播清除事件 */
            eventBus.emit("track:label-updated", { cameraId, trackId, name: "" });
          }
          return Response.json({ ok });
        }
        return Response.json({ error: "invalid path" }, { status: 400 });
      }

      /** 追踪目标列表（附带行为事件统计） */
      if (url.pathname === "/api/tracks" && req.method === "GET") {
        const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 200;
        const all = trackStorage.listTracks();
        const eventCounts = eventStorage.countByTrackId();
        const result = all.slice(0, limit).map(t => ({
          ...t,
          eventCount: eventCounts.get(t.trackId) ?? 0,
        }));
        return Response.json(result);
      }

      /** 追踪目标统计 */
      if (url.pathname === "/api/tracks/stats" && req.method === "GET") {
        const all = trackStorage.listTracks();
        const now = Date.now();
        const total = all.length;
        const named = all.filter(t => t.customName).length;
        const active = all.filter(t => now - t.lastSeen < 30000).length;
        /** 按标签统计 */
        const byLabel: Record<string, number> = {};
        for (const t of all) {
          byLabel[t.label] = (byLabel[t.label] ?? 0) + 1;
        }
        /** 按小时统计最近 24 小时的出现次数 */
        const byHour: Array<{ hour: number; count: number }> = [];
        const dayAgo = now - 86400000;
        for (let h = 0; h < 24; h++) {
          const hourStart = new Date(now).setHours(h, 0, 0, 0);
          const hourEnd = hourStart + 3600000;
          const count = all.filter(t => t.lastSeen >= Math.max(hourStart, dayAgo) && t.lastSeen < hourEnd).length;
          if (hourStart >= dayAgo) byHour.push({ hour: h, count });
        }
        return Response.json({ total, named, unnamed: total - named, active, byLabel, byHour });
      }

      /** 未命名目标的 dHash 匹配建议 */
      if (url.pathname === "/api/tracks/suggestions" && req.method === "GET") {
        return Response.json(trackStorage.getSuggestions());
      }

      /** 语义搜索追踪目标（CLIP text→image embedding 匹配） */
      if (url.pathname === "/api/tracks/semantic-search" && req.method === "GET") {
        const query = url.searchParams.get("q");
        if (!query || !clipService) {
          return Response.json([]);
        }
        const textResult = await clipService.textEmbed([query]);
        if (!textResult.embeddings[0]?.length) {
          return Response.json([]);
        }
        const queryEmbed = textResult.embeddings[0]!;
        const allTracks = trackStorage.listTracks();
        const eventCounts = eventStorage.countByTrackId();
        /** 计算每个目标的 CLIP embedding 与查询文本的余弦相似度 */
        const scored: Array<{ track: typeof allTracks[0]; score: number; eventCount: number }> = [];
        for (const t of allTracks) {
          const record = trackStorage.getRecord(t.trackId);
          if (!record?.clipEmbedding?.length) continue;
          /** 余弦相似度 = 点积（因为向量已 L2 归一化） */
          let dot = 0;
          for (let i = 0; i < queryEmbed.length; i++) {
            dot += queryEmbed[i]! * record.clipEmbedding[i]!;
          }
          if (dot > 0.2) {
            scored.push({ track: t, score: dot, eventCount: eventCounts.get(t.trackId) ?? 0 });
          }
        }
        /** 按相似度降序，返回前 50 个 */
        scored.sort((a, b) => b.score - a.score);
        const results = scored.slice(0, 50).map(s => ({
          ...s.track,
          eventCount: s.eventCount,
          searchScore: Math.round(s.score * 100) / 100,
        }));
        return Response.json(results);
      }

      /** CLIP 候选标签管理 */
      if (url.pathname === "/api/clip-candidates" && req.method === "GET") {
        const { getAllCandidates } = await import("@/ai/clip-service");
        return Response.json(getAllCandidates());
      }
      if (url.pathname === "/api/clip-candidates" && req.method === "PUT") {
        const body = await req.json() as Record<string, string[]>;
        /** 校验格式：key 是非空字符串，value 是非空字符串数组 */
        const valid: Record<string, string[]> = {};
        for (const [key, val] of Object.entries(body)) {
          if (!key || !Array.isArray(val) || val.length === 0) continue;
          if (val.every(v => typeof v === "string" && v.length > 0)) {
            valid[key] = val;
          }
        }
        const { setCustomCandidates } = await import("@/ai/clip-service");
        setCustomCandidates(valid);
        /** 持久化到运行时配置 + preferences storage */
        runtimeConfig.patchFromJSON({ ai: { clip: { candidates: valid } } });
        preferencesStorage.set("clip-candidates", valid);
        return Response.json({ ok: true });
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

      /** 查询追踪目标轨迹 */
      if (url.pathname.startsWith("/api/tracks/trajectory/")) {
        const parts = url.pathname.split("/");
        /** /api/tracks/trajectory/:trackId — 单目标轨迹 */
        if (parts.length === 5 && req.method === "GET") {
          const trackId = parseInt(parts[4]!);
          if (!trackId || !trajectoryStorage) return Response.json({ points: [] });
          const since = url.searchParams.get("since");
          const sinceMs = since ? parseInt(since) : Date.now() - 300_000;
          const points = trajectoryStorage.getTrajectory(trackId, sinceMs);
          return Response.json({ trackId, points });
        }
      }

      /** 查询摄像头所有活跃目标轨迹 */
      if (url.pathname.startsWith("/api/tracks/trajectory-camera/")) {
        const parts = url.pathname.split("/");
        /** /api/tracks/trajectory-camera/:cameraId */
        if (parts.length === 5 && req.method === "GET") {
          const cameraId = parts[4]!;
          if (!trajectoryStorage) return Response.json([]);
          const since = url.searchParams.get("since");
          const sinceMs = since ? parseInt(since) : Date.now() - 120_000;
          const trajectories = trajectoryStorage.getCameraTrajectories(cameraId, sinceMs);
          return Response.json(trajectories);
        }
      }

      /** 摄像头轨迹热力图 GET /api/tracks/heatmap/:cameraId */
      if (url.pathname.startsWith("/api/tracks/heatmap/")) {
        const parts = url.pathname.split("/");
        if (parts.length === 5 && req.method === "GET") {
          const cameraId = parts[4]!;
          if (!trajectoryStorage) return Response.json({ grid: [], maxCount: 0, totalPoints: 0 });
          const cols = parseInt(url.searchParams.get("cols") ?? "20") || 20;
          const rows = parseInt(url.searchParams.get("rows") ?? "15") || 15;
          const since = url.searchParams.get("since");
          const sinceMs = since ? parseInt(since) : Date.now() - 3_600_000;
          const trackId = url.searchParams.get("trackId") ? parseInt(url.searchParams.get("trackId")!) : undefined;
          const heatmap = trajectoryStorage.getHeatmap(cameraId, cols, rows, sinceMs, trackId);
          return Response.json(heatmap);
        }
      }

      /** 查询追踪目标活跃时段分布（24小时按小时统计） */
      if (url.pathname.startsWith("/api/tracks/activity/")) {
        const parts = url.pathname.split("/");
        if (parts.length === 5 && req.method === "GET") {
          const trackId = parseInt(parts[4]!);
          if (!trackId || !trajectoryStorage) return Response.json({ hours: [] });
          /** 查询最近 7 天的轨迹点 */
          const points = trajectoryStorage.getTrajectory(trackId, Date.now() - 7 * 86_400_000, 10000);
          /** 按小时统计 */
          const hourCounts = new Array(24).fill(0);
          for (const p of points) {
            const h = new Date(p.ts).getHours();
            hourCounts[h]!++;
          }
          return Response.json({ hours: hourCounts.map((count, hour) => ({ hour, count })), total: points.length });
        }
      }

      /** 目标区域停留统计 GET /api/tracks/zone-stats/:trackId */
      if (url.pathname.startsWith("/api/tracks/zone-stats/")) {
        const parts = url.pathname.split("/");
        if (parts.length === 5 && req.method === "GET") {
          const trackId = parseInt(parts[4]!);
          if (!trackId) return Response.json([]);
          /** 从 leave-zone 事件中聚合停留时长（leave-zone 事件包含 dwellMs） */
          const since = url.searchParams.has("since") ? Number(url.searchParams.get("since")) : Date.now() - 7 * 86_400_000;
          const rawEvents = eventStorage.query({
            typeLike: "track:leave-zone%",
            since,
            limit: 500,
            search: `"trackId":${trackId}`,
          });
          /** 按区域聚合停留时长 */
          const zoneMap = new Map<string, { zoneName: string; totalDwellMs: number; visits: number }>();
          for (const ev of rawEvents) {
            if (!ev.detail) continue;
            const d = JSON.parse(ev.detail) as { trackId?: number; zoneName?: string; dwellMs?: number };
            if (d.trackId !== trackId || !d.zoneName) continue;
            const key = d.zoneName;
            const existing = zoneMap.get(key);
            if (existing) {
              existing.totalDwellMs += d.dwellMs ?? 0;
              existing.visits++;
            } else {
              zoneMap.set(key, { zoneName: d.zoneName, totalDwellMs: d.dwellMs ?? 0, visits: 1 });
            }
          }
          return Response.json([...zoneMap.values()].sort((a, b) => b.totalDwellMs - a.totalDwellMs));
        }
      }

      /** 合并追踪目标 */
      if (url.pathname === "/api/tracks/merge" && req.method === "POST") {
        const body = await req.json() as { sourceId?: number; targetId?: number };
        if (!body.sourceId || !body.targetId) {
          return Response.json({ error: "sourceId and targetId required" }, { status: 400 });
        }
        const ok = trackStorage.merge(body.sourceId, body.targetId);
        if (!ok) return Response.json({ error: "merge failed" }, { status: 400 });
        /** 清理源目标的轨迹数据 */
        if (trajectoryStorage) trajectoryStorage.deleteByTrackId(body.sourceId);
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
        const track = trackStorage.getTrack(trackId);
        const ok = trackStorage.remove(trackId);
        if (!ok) return Response.json({ error: "not found" }, { status: 404 });
        /** 清理关联数据 */
        if (track) {
          for (const camId of track.cameraIds) {
            trackLabelStorage.removeByTrack(camId, trackId);
          }
          if (trajectoryStorage) trajectoryStorage.deleteByTrackId(trackId);
        }
        return Response.json({ ok: true });
      }

      /** 追踪目标检测事件历史 */
      const trackEventsMatch = url.pathname.match(/^\/api\/tracks\/(\d+)\/events$/);
      if (trackEventsMatch && req.method === "GET") {
        const trackId = parseInt(trackEventsMatch[1]!);
        const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 50;
        /** 使用 json_extract 精确匹配 trackId（替代 LIKE 搜索，性能更好） */
        const merged = eventStorage.query({ trackId, limit });
        merged.sort((a: { timestamp: number }, b: { timestamp: number }) => b.timestamp - a.timestamp);
        return Response.json(merged.slice(0, limit));
      }

      /** 按 trackId 获取快照图片 GET /api/tracks/:trackId/snapshot */
      const trackSnapshotMatch = url.pathname.match(/^\/api\/tracks\/(\d+)\/snapshot$/);
      if (trackSnapshotMatch && req.method === "GET") {
        const trackId = parseInt(trackSnapshotMatch[1]!);
        const track = trackStorage.getTrack(trackId);
        if (!track?.snapshotFile) return new Response("Not Found", { status: 404 });
        const filePath = trackStorage.getSnapshotPath(track.snapshotFile);
        if ((await Bun.file(filePath).size) === undefined) return new Response("Not Found", { status: 404 });
        const file = Bun.file(filePath);
        return new Response(file);
      }

      /** 追踪目标快照图片（按文件名） */
      if (url.pathname.startsWith("/api/tracks/snapshot/") && req.method === "GET") {
        const filename = url.pathname.slice("/api/tracks/snapshot/".length);
        const filePath = trackStorage.getSnapshotPath(filename);
        if ((await Bun.file(filePath).size) === undefined) return new Response("Not Found", { status: 404 });
        const file = Bun.file(filePath);
        return new Response(file);
      }

      /** API 路径未匹配 → 404 */
      if (url.pathname.startsWith("/api/")) {
        return new Response("Not Found", { status: 404 });
      }

      /** 静态文件服务：服务前端构建产物 */
      return await serveStatic(url.pathname);
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
        /** 清理客户端节流状态，释放内存 */
        const wsData = ws as unknown as { lastPushTimeByCamera?: Map<string, number>; subscribedCameras?: Set<string> };
        wsData.lastPushTimeByCamera = undefined;
        wsData.subscribedCameras = undefined;
        console.log(`[WS] 客户端断开，当前 ${wsClients.size} 个`);
      },
      message(ws, raw) {
        if (typeof raw !== "string") return;
        /** 解析 JSON 消息（心跳 + 订阅共用一次解析） */
        let msg: { type: string; cameraIds?: string[] };
        try { msg = JSON.parse(raw); } catch { return; }
        if (msg.type === "pong") {
          wsLastPong.set(ws, Date.now());
          return;
        }
        if (msg.type === "subscribe" && Array.isArray(msg.cameraIds)) {
          (ws as unknown as { subscribedCameras: Set<string> }).subscribedCameras = new Set(msg.cameraIds);
        } else if (msg.type === "unsubscribe") {
          (ws as unknown as { subscribedCameras?: Set<string> }).subscribedCameras = undefined;
        }
      },
    },
  });

  /**
   * 帧推送：事件驱动 + 按客户端节流
   * 帧到达后立即检查是否可推送，每路摄像头独立节流
   * 节流间隔基于每个客户端订阅的摄像头数量（而非全局数量）
   * 全屏只看 1 路时可达 30fps，多路时自适应降速
   */

  /** 每路摄像头最新帧缓存 */
  const latestFrameByCamera = new Map<string, { data: Buffer; timestamp: number }>();

  /** 缓存 importantLabels Set，避免每次 detect 事件重建 */
  let cachedImportantSet: Set<string> | null = null;
  let cachedImportantLabels = "";
  function getImportantSet(): Set<string> | null {
    const labels = runtimeConfig.get().ai.importantLabels.join(",");
    if (labels !== cachedImportantLabels) {
      cachedImportantLabels = labels;
      cachedImportantSet = labels.length > 0 ? new Set(runtimeConfig.get().ai.importantLabels.map(l => l.toLowerCase())) : null;
    }
    return cachedImportantSet;
  }

  /**
   * 根据客户端订阅摄像头数量计算帧推送节流间隔
   * 1-2 路: 30fps (33ms)，3-4 路: 25fps (40ms)，5-8 路: 20fps (50ms)，9+ 路: 15fps (67ms)
   */
  function getThrottleMs(subscribedCount: number): number {
    if (subscribedCount <= 2) return 33;
    if (subscribedCount <= 4) return 40;
    if (subscribedCount <= 8) return 50;
    return 67;
  }

  /** 是否有待推送的帧（pending push flag） */
  let pushScheduled = false;

  /** 执行帧推送 */
  function flushFrames() {
    pushScheduled = false;
    if (wsClients.size === 0 || latestFrameByCamera.size === 0) return;

    const now = Date.now();
    let hasThrottled = false;

    for (const [cameraId, frame] of latestFrameByCamera) {
      latestFrameByCamera.delete(cameraId);

      /** 该摄像头有 fMP4 客户端时跳过 JPEG 帧推送（fMP4 已提供 GPU 解码视频） */
      if (fmp4ActiveCameras.has(cameraId)) continue;

      /** 先收集允许推送的客户端列表 */
      const targets: Array<{ ws: typeof wsClients extends Set<infer T> ? T : never; throttleMs: number }> = [];
      for (const ws of wsClients) {
        const wsData = ws as unknown as { subscribedCameras?: Set<string>; lastPushTimeByCamera?: Map<string, number> };
        const subscribed = wsData.subscribedCameras;
        if (subscribed && !subscribed.has(cameraId)) continue;
        const subCount = subscribed?.size ?? latestFrameByCamera.size + 1;
        const throttleMs = getThrottleMs(subCount);
        if (!wsData.lastPushTimeByCamera) wsData.lastPushTimeByCamera = new Map();
        const lastPush = wsData.lastPushTimeByCamera.get(cameraId) ?? 0;
        if (now - lastPush < throttleMs) {
          hasThrottled = true;
          continue;
        }
        wsData.lastPushTimeByCamera.set(cameraId, now);
        targets.push({ ws, throttleMs });
      }

      if (targets.length === 0) continue;

      /** 编码帧（仅在有目标时） */
      const header = { event: "frame", cameraId, timestamp: frame.timestamp };
      const headerBuf = textEncoder.encode(JSON.stringify(header));
      headerLenView.setUint32(0, headerBuf.byteLength, true);
      const message = new Uint8Array(4 + headerBuf.byteLength + frame.data.length);
      message.set(headerLenBuf, 0);
      message.set(headerBuf, 4);
      message.set(frame.data, 4 + headerBuf.byteLength);

      for (const { ws } of targets) {
        try {
          /** 背压保护：客户端发送缓冲区积压超过 1MB 时跳过，防止内存泄漏 */
          if (ws.getBufferedAmount() > 1048576) continue;
          ws.send(message);
        } catch {
          /** 单个客户端发送失败不影响其他客户端 */
        }
      }
    }

    /** 如果还有被节流的帧，安排下次 flush */
    if (hasThrottled && !pushScheduled) {
      pushScheduled = true;
      setTimeout(flushFrames, 33);
    }
  }

  /** 调度帧推送（事件驱动） */
  function schedulePush() {
    if (pushScheduled) return;
    pushScheduled = true;
    /** 用 setImmediate 在当前事件循环 tick 结束后立即推送，比 setTimeout(0) 更快 */
    setImmediate(flushFrames);
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
        const detectPayload = payload as { cameraId: string; timestamp: number; detections: Array<{ label: string; score: number; box: unknown; trackId?: number; trackName?: string; semanticLabel?: string }>; changed?: boolean; inferMs?: number };
        /** unchanged 时跳过完整推送，只发轻量心跳（减少 ~90% 带宽） */
        if (detectPayload.changed === false) {
          header = { event, cameraId: detectPayload.cameraId, timestamp: detectPayload.timestamp, changed: false, inferMs: detectPayload.inferMs };
        } else {
          /** 只推送 importantLabels 中的检测结果给前端，减少 WS 带宽 */
          const importantSet = getImportantSet();
          const filteredDetections = importantSet
            ? detectPayload.detections.filter(d => importantSet.has((d.label as string).toLowerCase()))
            : detectPayload.detections;
          header = { event, cameraId: detectPayload.cameraId, timestamp: detectPayload.timestamp, detections: filteredDetections, changed: detectPayload.changed, inferMs: detectPayload.inferMs };
        }
      } else {
        header = { event, ...payload };
      }

      if (wsClients.size === 0) return;

      /** 二进制协议：[4字节头长度 LE uint32][JSON头] */
      const headerBuf = textEncoder.encode(JSON.stringify(header));
      headerLenView.setUint32(0, headerBuf.byteLength, true);

      const message = new Uint8Array(4 + headerBuf.byteLength);
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
async function serveStatic(pathname: string): Promise<Response> {
  /** 去掉前导 / */
  let filePath = resolve(STATIC_DIR, pathname.slice(1) || "index.html");

  /** 安全检查：确保路径在静态目录内 */
  if (!filePath.startsWith(STATIC_DIR)) {
    return new Response("Forbidden", { status: 403 });
  }

  /** 如果文件不存在，SPA fallback 到 index.html（单次 stat 检查） */
  if (!await Bun.file(filePath).exists()) {
    filePath = resolve(STATIC_DIR, "index.html");
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
