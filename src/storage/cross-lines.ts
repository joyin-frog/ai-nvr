import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** 越线检测线段 */
export interface CrossLine {
  /** 线段 ID */
  id: number;
  /** 摄像头 ID */
  cameraId: string;
  /** 线段名称 */
  name: string;
  /** 起点坐标（归一化 0-1） */
  start: { x: number; y: number };
  /** 终点坐标（归一化 0-1） */
  end: { x: number; y: number };
  /** 是否启用 */
  enabled: boolean;
}

/** 数据库行结构 */
interface CrossLineRow {
  id: number;
  camera_id: string;
  name: string;
  start_x: number;
  start_y: number;
  end_x: number;
  end_y: number;
  enabled: number;
}

/**
 * 越线检测线段存储
 * 每个摄像头可以定义多条检测线段
 * 当追踪目标穿越线段时触发 track:line-cross 事件
 */
export class CrossLineStorage {
  private db: Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = NORMAL");
    this.db.run("PRAGMA busy_timeout = 5000");
    this.db.run("PRAGMA wal_autocheckpoint = 1000");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS cross_lines (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        camera_id TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        start_x REAL NOT NULL,
        start_y REAL NOT NULL,
        end_x REAL NOT NULL,
        end_y REAL NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1
      )
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_cross_lines_camera ON cross_lines(camera_id)");
  }

  /** 获取某个摄像头的所有检测线段 */
  list(cameraId: string): CrossLine[] {
    const rows = this.db.query(
      "SELECT * FROM cross_lines WHERE camera_id = ?"
    ).all(cameraId) as CrossLineRow[];
    return rows.map(this.rowToCrossLine);
  }

  /** 获取所有检测线段 */
  listAll(): CrossLine[] {
    const rows = this.db.query(
      "SELECT * FROM cross_lines ORDER BY id"
    ).all() as CrossLineRow[];
    return rows.map(this.rowToCrossLine);
  }

  /** 按 ID 获取 */
  getById(id: number): CrossLine | undefined {
    const row = this.db.query(
      "SELECT * FROM cross_lines WHERE id = ?"
    ).get(id) as CrossLineRow | undefined;
    return row ? this.rowToCrossLine(row) : undefined;
  }

  /** 获取某个摄像头所有启用的线段（解析后） */
  getEnabledLines(cameraId: string): Array<{
    id: number;
    name: string;
    start: { x: number; y: number };
    end: { x: number; y: number };
  }> {
    const rows = this.db.query(
      "SELECT * FROM cross_lines WHERE camera_id = ? AND enabled = 1"
    ).all(cameraId) as CrossLineRow[];
    return rows.map(r => ({
      id: r.id,
      name: r.name,
      start: { x: r.start_x, y: r.start_y },
      end: { x: r.end_x, y: r.end_y },
    }));
  }

  /** 添加检测线段 */
  add(cameraId: string, name: string, start: { x: number; y: number }, end: { x: number; y: number }): number {
    const result = this.db.query(
      "INSERT INTO cross_lines (camera_id, name, start_x, start_y, end_x, end_y, enabled) VALUES (?, ?, ?, ?, ?, ?, 1) RETURNING id"
    ).get(cameraId, name, start.x, start.y, end.x, end.y);
    return (result as { id: number }).id;
  }

  /** 更新检测线段 */
  update(id: number, updates: {
    name?: string;
    start?: { x: number; y: number };
    end?: { x: number; y: number };
    enabled?: boolean;
  }): boolean {
    const sets: string[] = [];
    const params: (string | number)[] = [];

    if (updates.name !== undefined) { sets.push("name = ?"); params.push(updates.name); }
    if (updates.start !== undefined) { sets.push("start_x = ?", "start_y = ?"); params.push(updates.start.x, updates.start.y); }
    if (updates.end !== undefined) { sets.push("end_x = ?", "end_y = ?"); params.push(updates.end.x, updates.end.y); }
    if (updates.enabled !== undefined) { sets.push("enabled = ?"); params.push(updates.enabled ? 1 : 0); }

    if (sets.length === 0) return false;
    params.push(id);

    const result = this.db.run(
      `UPDATE cross_lines SET ${sets.join(", ")} WHERE id = ?`,
      params
    );
    return result.changes > 0;
  }

  /** 删除检测线段 */
  remove(id: number): boolean {
    const result = this.db.run("DELETE FROM cross_lines WHERE id = ?", [id]);
    return result.changes > 0;
  }

  /** 数据库行 → CrossLine 对象 */
  private rowToCrossLine(row: CrossLineRow): CrossLine {
    return {
      id: row.id,
      cameraId: row.camera_id,
      name: row.name,
      start: { x: row.start_x, y: row.start_y },
      end: { x: row.end_x, y: row.end_y },
      enabled: row.enabled === 1,
    };
  }

  /** 关闭数据库 */
  close(): void {
    this.db.close();
  }
}
