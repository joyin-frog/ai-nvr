import { type AuthConfig } from "@/config";

/** 不需要认证的路径白名单 */
const PUBLIC_PATHS = new Set([
  "/api/auth/check",
  "/api/auth/login",
]);

/**
 * 认证检查
 * token 为空时跳过认证（兼容无认证模式）
 * 支持 Authorization: Bearer <token> 和 ?token=<token>（WebSocket 用）
 */
export function checkAuth(config: AuthConfig, req: Request): boolean {
  if (!config.token) return true;

  const url = new URL(req.url);
  if (PUBLIC_PATHS.has(url.pathname)) return true;

  /** 静态文件不认证（前端 index.html 需要加载） */
  if (!url.pathname.startsWith("/api/")) return true;

  /** 检查 Authorization header */
  const auth = req.headers.get("authorization");
  if (auth === `Bearer ${config.token}`) return true;

  /** 检查 URL query 参数（WebSocket 连接用） */
  const queryToken = url.searchParams.get("token");
  if (queryToken === config.token) return true;

  return false;
}
