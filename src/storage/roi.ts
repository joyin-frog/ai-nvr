import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** 检测区域（多边形） */
export interface RegionOfInterest {
  /** 区域 ID */
  id: number;
  /** 摄像头 ID */
  cameraId: string;
  /** 区域名称 */
  name: string;
  /** 多边形顶点坐标（归一化 0-1），JSON 数组 [{x, y}, ...] */
  points: string;
  /** 是否启用 */
  enabled: boolean;
}

/**
 * ROI（Region of Interest）存储
 * 每个摄像头可以有多个检测区域（多边形）
 * 运动检测只在 ROI 内计算像素差异
 */
export class RoiStorage {
  private db: Database;
  /** getEnabledPolygons 的 TTL 缓存（30 秒） */
  private polygonCache = new Map<string, { data: ReturnType<RoiStorage["getEnabledPolygons"]>; expiry: number }>();
  private static readonly POLYGON_CACHE_TTL = 30_000;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = NORMAL");
    this.db.run("PRAGMA busy_timeout = 5000");
    this.db.run("PRAGMA wal_autocheckpoint = 1000");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS roi (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        camera_id TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        points TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1
      )
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_roi_camera ON roi(camera_id)");
  }

  /** 获取某个摄像头的所有 ROI */
  list(cameraId: string): RegionOfInterest[] {
    return this.db.query(
      "SELECT id, camera_id as cameraId, name, points, enabled FROM roi WHERE camera_id = ?"
    ).all(cameraId) as RegionOfInterest[];
  }

  /** 获取所有 ROI */
  listAll(): RegionOfInterest[] {
    return this.db.query(
      "SELECT id, camera_id as cameraId, name, points, enabled FROM roi ORDER BY id"
    ).all() as RegionOfInterest[];
  }

  /** 按 ID 获取 ROI */
  getById(id: number): { id: number; cameraId: string; name: string; points: string; enabled: boolean } | undefined {
    return this.db.query(
      "SELECT id, camera_id as cameraId, name, points, enabled FROM roi WHERE id = ?"
    ).get(id) as { id: number; cameraId: string; name: string; points: string; enabled: boolean } | undefined;
  }

  /** 添加 ROI */
  add(cameraId: string, name: string, points: string): number {
    const result = this.db.query(
      "INSERT INTO roi (camera_id, name, points, enabled) VALUES (?, ?, ?, 1) RETURNING id"
    ).get(cameraId, name, points);
    this.invalidateCache(cameraId);
    return (result as { id: number }).id;
  }

  /** 更新 ROI */
  update(id: number, updates: { name?: string; points?: string; enabled?: boolean }): boolean {
    const sets: string[] = [];
    const params: (string | number)[] = [];

    if (updates.name !== undefined) { sets.push("name = ?"); params.push(updates.name); }
    if (updates.points !== undefined) { sets.push("points = ?"); params.push(updates.points); }
    if (updates.enabled !== undefined) { sets.push("enabled = ?"); params.push(updates.enabled ? 1 : 0); }

    if (sets.length === 0) return false;
    params.push(id);

    const result = this.db.run(
      `UPDATE roi SET ${sets.join(", ")} WHERE id = ?`,
      params
    );
    if (result.changes > 0) {
      const row = this.db.prepare("SELECT camera_id FROM roi WHERE id = ?").get(id) as { camera_id: string } | undefined;
      if (row) this.invalidateCache(row.camera_id);
    }
    return result.changes > 0;
  }

  /** 删除 ROI */
  remove(id: number): boolean {
    const row = this.db.prepare("SELECT camera_id FROM roi WHERE id = ?").get(id) as { camera_id: string } | undefined;
    const cameraId = row?.camera_id;
    const result = this.db.run("DELETE FROM roi WHERE id = ?", [id]);
    if (result.changes > 0 && cameraId) this.invalidateCache(cameraId);
    return result.changes > 0;
  }

  /** 获取某个摄像头所有启用的 ROI（解析后的多边形，带 TTL 缓存） */
  getEnabledPolygons(cameraId: string): Array<{ id: number; name: string; points: Array<{ x: number; y: number }> }> {
    const cached = this.polygonCache.get(cameraId);
    if (cached && cached.expiry > Date.now()) return cached.data;

    const rows = this.db.query(
      "SELECT id, name, points FROM roi WHERE camera_id = ? AND enabled = 1"
    ).all(cameraId) as Array<{ id: number; name: string; points: string }>;

    const data = rows.map(row => ({
      id: row.id,
      name: row.name,
      points: JSON.parse(row.points) as Array<{ x: number; y: number }>,
    }));

    this.polygonCache.set(cameraId, { data, expiry: Date.now() + RoiStorage.POLYGON_CACHE_TTL });
    return data;
  }

  /** 使缓存失效（ROI 增删改时调用） */
  invalidateCache(cameraId?: string): void {
    if (cameraId) this.polygonCache.delete(cameraId);
    else this.polygonCache.clear();
  }

  /** 关闭数据库 */
  close(): void {
    this.db.close();
  }
}
