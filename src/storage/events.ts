import { Database, type SQLQueryBindings } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** 事件持久化存储 */
export class EventStorage {
  private db: Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        camera_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        detail TEXT
      )
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_events_type ON events(type)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_events_camera ON events(camera_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp)");
  }

  /** 插入事件 */
  insert(type: string, cameraId: string, timestamp: number, detail?: string): number {
    const result = this.db.query(
      "INSERT INTO events (type, camera_id, timestamp, detail) VALUES (?, ?, ?, ?) RETURNING id"
    ).get(type, cameraId, timestamp, detail ?? null);
    return (result as { id: number }).id;
  }

  /** 查询事件列表 */
  query(options: {
    type?: string;
    cameraId?: string;
    since?: number;
    until?: number;
    limit?: number;
    offset?: number;
    search?: string;
  } = {}): EventRecord[] {
    const { conditions, params } = this.buildConditions(options);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    return this.db.query(
      `SELECT * FROM events ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as EventRecord[];
  }

  /** 统计事件数量 */
  count(options: { type?: string; cameraId?: string; since?: number; until?: number; search?: string } = {}): number {
    const { conditions, params } = this.buildConditions(options);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = this.db.query(`SELECT COUNT(*) as count FROM events ${where}`).get(...params) as { count: number };
    return result.count;
  }

  /** 删除过期事件 */
  purge(beforeTimestamp: number): number {
    const result = this.db.run("DELETE FROM events WHERE timestamp < ?", [beforeTimestamp]);
    return result.changes;
  }

  /** 按类型统计事件数量 */
  countByType(options: { since?: number; until?: number } = {}): Record<string, number> {
    const { conditions, params } = this.buildConditions(options);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db.query(
      `SELECT type, COUNT(*) as count FROM events ${where} GROUP BY type`
    ).all(...params) as Array<{ type: string; count: number }>;
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.type] = row.count;
    }
    return result;
  }

  /** 按小时统计事件数量（用于时间线图表） */
  countByHour(options: { since?: number; until?: number } = {}): Array<{ hour: number; count: number; type: string }> {
    const { conditions, params } = this.buildConditions(options);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    return this.db.query(
      `SELECT (timestamp / 3600000) * 3600000 as hour_ts, type, COUNT(*) as count FROM events ${where} GROUP BY hour_ts, type ORDER BY hour_ts`
    ).all(...params) as Array<{ hour: number; count: number; type: string }>;
  }

  /** 按摄像头统计事件数量 */
  countByCamera(options: { since?: number; until?: number; type?: string } = {}): Array<{ camera_id: string; count: number }> {
    const { conditions, params } = this.buildConditions(options);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    return this.db.query(
      `SELECT camera_id, COUNT(*) as count FROM events ${where} GROUP BY camera_id ORDER BY count DESC`
    ).all(...params) as Array<{ camera_id: string; count: number }>;
  }

  /** 关闭数据库 */
  close(): void {
    this.db.close();
  }

  /** 构建查询条件 */
  private buildConditions(options: { type?: string; cameraId?: string; since?: number; until?: number; search?: string }): { conditions: string[]; params: SQLQueryBindings[] } {
    const conditions: string[] = [];
    const params: SQLQueryBindings[] = [];

    if (options.type) {
      conditions.push("type = ?");
      params.push(options.type);
    }
    if (options.cameraId) {
      conditions.push("camera_id = ?");
      params.push(options.cameraId);
    }
    if (options.since) {
      conditions.push("timestamp >= ?");
      params.push(options.since);
    }
    if (options.until) {
      conditions.push("timestamp <= ?");
      params.push(options.until);
    }
    if (options.search) {
      conditions.push("detail LIKE ?");
      params.push(`%${options.search}%`);
    }

    return { conditions, params };
  }
}

/** 事件记录 */
export interface EventRecord {
  id: number;
  type: string;
  camera_id: string;
  timestamp: number;
  detail: string | null;
}
