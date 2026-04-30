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
import { addCameraToConfig, removeCameraFromConfig, updateCameraInConfig, loadConfig } from "@/config";
import { existsSync, statSync, realpathSync } from "node:fs";
import { resolve, extname } from "node:path";

/** WebSocket 客户端集合 */
const wsClients = new Set<import("bun").ServerWebSocket>();

/** 要推送给前端的事件列表 */
const PUSH_EVENTS: EventName[] = ["frame", "motion", "detect", "camera:online", "camera:offline", "alert"];

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
): void {
  Bun.serve({
    port,
    fetch(req, server) {
      const url = new URL(req.url);

      /** WebSocket 升级（精确匹配，避免与 /api/events/history 冲突） */
      if (url.pathname === "/api/events" && req.headers.get("upgrade") === "websocket") {
        if (server.upgrade(req)) return;
        return new Response("WebSocket upgrade failed", { status: 500 });
      }

      /** REST API */
      if (url.pathname === "/" || url.pathname === "/api") {
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
        return Response.json(cameraManager.getStatus());
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
          addCameraToConfig({ id, friendlyName, hdUrl, sdUrl, detectFps: obj.detectFps as number | undefined });
          /** 触发配置热重载 */
          const newConfig = loadConfig();
          cameraManager.reloadConfig(newConfig);
          return Response.json({ ok: true, cameraId: id });
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
          const updated = runtimeConfig.patchFromJSON(body);
          return Response.json(updated);
        }).catch(() => new Response("Invalid JSON", { status: 400 }));
      }

      /** 查询事件历史 */
      if (url.pathname === "/api/events/history") {
        const events = eventStorage.query({
          type: url.searchParams.get("type") ?? undefined,
          cameraId: url.searchParams.get("cameraId") ?? undefined,
          since: url.searchParams.has("since") ? Number(url.searchParams.get("since")) : undefined,
          until: url.searchParams.has("until") ? Number(url.searchParams.get("until")) : undefined,
          limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 100,
          offset: url.searchParams.has("offset") ? Number(url.searchParams.get("offset")) : 0,
        });
        const total = eventStorage.count({
          type: url.searchParams.get("type") ?? undefined,
          cameraId: url.searchParams.get("cameraId") ?? undefined,
          since: url.searchParams.has("since") ? Number(url.searchParams.get("since")) : undefined,
          until: url.searchParams.has("until") ? Number(url.searchParams.get("until")) : undefined,
        });
        return Response.json({ events, total });
      }

      /** 获取摄像头最新帧（实时视频用，已预压缩） */
      const snapshotMatch = url.pathname.match(/^\/api\/snapshot\/(.+)$/);
      if (snapshotMatch) {
        const cameraId = snapshotMatch[1]!;
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
        return Response.json(recorder.listRecordings(cameraId));
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

      /** 获取标注后的图片 */
      const annotatedMatch = url.pathname.match(/^\/api\/detection\/annotated\/(.+)$/);
      if (annotatedMatch) {
        const cameraId = annotatedMatch[1]!;
        const image = annotator.getLatest(cameraId);
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

      /** 下载导出文件 */
      const exportDownloadMatch = url.pathname.match(/^\/api\/recordings\/export\/(.+\.mp4)$/);
      if (exportDownloadMatch && req.method === "GET") {
        const filename = exportDownloadMatch[1]!;
        const exportRoot = realpathSync(exporter.getExportPath("."));
        const filePath = exporter.getExportPath(filename);
        if (!existsSync(filePath)) return new Response("Not Found", { status: 404 });
        const resolved = realpathSync(filePath);
        if (!resolved.startsWith(exportRoot)) return new Response("Forbidden", { status: 403 });

        const stat = statSync(filePath);
        const file = Bun.file(filePath);
        return new Response(file, {
          headers: {
            "Content-Type": "video/mp4",
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
            windowSeconds: (obj.windowSeconds as number) ?? 60,
            threshold: (obj.threshold as number) ?? 3,
            cooldownSeconds: (obj.cooldownSeconds as number) ?? 300,
            silentStart: (obj.silentStart as string) ?? "",
            silentEnd: (obj.silentEnd as string) ?? "",
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
          for (const key of ["name", "eventType", "cameraId", "labels", "windowSeconds", "threshold", "cooldownSeconds", "enabled", "silentStart", "silentEnd"]) {
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

      /** API 路径未匹配 → 404 */
      if (url.pathname.startsWith("/api/")) {
        return new Response("Not Found", { status: 404 });
      }

      /** 静态文件服务：服务前端构建产物 */
      return serveStatic(url.pathname);
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

  /** 监听事件并推送给所有 WebSocket 客户端 */
  for (const event of PUSH_EVENTS) {
    eventBus.on(event, (payload) => {
      /** 构建 JSON 头（不含二进制数据） */
      const header: Record<string, unknown> = { event, ...payload };

      let frameData: Buffer | null = null;

      if (event === "frame") {
        /** 帧事件：提取二进制数据，头中不包含 */
        frameData = (payload as { data: Buffer }).data;
        header.data = undefined;
      }
      if (event === "detect") {
        header.annotatedImage = undefined;
      }

      /** 二进制协议：[4字节头长度 LE uint32][JSON头][可选二进制帧] */
      const headerBuf = Buffer.from(JSON.stringify(header), "utf-8");
      const headerLen = Buffer.alloc(4);
      headerLen.writeUInt32LE(headerBuf.length, 0);

      for (const ws of wsClients) {
        if (frameData) {
          ws.send(Buffer.concat([headerLen, headerBuf, frameData]));
        } else {
          ws.send(Buffer.concat([headerLen, headerBuf]));
        }
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
