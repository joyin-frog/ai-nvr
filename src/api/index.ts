import { type CameraManager } from "@/camera/manager";
import { type EventBus, type EventName } from "@/event-bus";

/** WebSocket 客户端集合 */
const wsClients = new Set<import("bun").ServerWebSocket>();

/** 要推送给前端的事件列表 */
const PUSH_EVENTS: EventName[] = ["frame", "motion", "camera:online", "camera:offline"];

/**
 * 启动 HTTP + WebSocket 服务
 */
export function startServer(
  port: number,
  cameraManager: CameraManager,
  eventBus: EventBus,
): void {
  Bun.serve({
    port,
    fetch(req, server) {
      const url = new URL(req.url);

      /** WebSocket 升级 */
      if (url.pathname === "/api/events") {
        if (server.upgrade(req)) return;
        return new Response("WebSocket upgrade failed", { status: 500 });
      }

      /** REST API */
      if (url.pathname === "/api/cameras") {
        return Response.json(cameraManager.getStatus());
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
      /** 帧事件只推送元信息，不推送帧数据（太大） */
      const wsPayload = { event, ...payload };
      if (event === "frame") {
        (wsPayload as Record<string, unknown>).data = undefined;
      }
      const msg = JSON.stringify(wsPayload);
      for (const ws of wsClients) {
        ws.send(msg);
      }
    });
  }

  console.log(`[Server] HTTP + WebSocket 服务已启动: http://localhost:${port}`);
}
