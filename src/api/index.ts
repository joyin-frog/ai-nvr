import { type CameraManager } from "@/camera/manager";
import { type EventBus, type EventName } from "@/event-bus";
import { type Annotator } from "@/ai/annotator";
import { type EventStorage } from "@/storage/events";
import { type MotionRecorder } from "@/storage/recorder";
import { type SystemMonitor } from "@/monitor";
import { type RuntimeConfig } from "@/runtime-config";
import { addCameraToConfig, removeCameraFromConfig, updateCameraInConfig, loadConfig } from "@/config";
import { existsSync, statSync, realpathSync } from "node:fs";

/** WebSocket 客户端集合 */
const wsClients = new Set<import("bun").ServerWebSocket>();

/** 要推送给前端的事件列表 */
const PUSH_EVENTS: EventName[] = ["frame", "motion", "detect", "camera:online", "camera:offline"];

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
        return Response.json(monitor.getMetrics(cameraIds));
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

      return new Response("Not Found", { status: 404 });
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
