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
    this.db.run("PRAGMA wal_autocheckpoint = 1000");
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
    /** 复合索引：优化按摄像头+时间范围查询 */
    this.db.run("CREATE INDEX IF NOT EXISTS idx_events_camera_time ON events(camera_id, timestamp)");
    /** 复合索引：优化按类型+时间范围查询 */
    this.db.run("CREATE INDEX IF NOT EXISTS idx_events_type_time ON events(type, timestamp)");
    /** 迁移：添加 starred 列 */
    const cols = this.db.query("PRAGMA table_info(events)").all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === "starred")) {
      this.db.run("ALTER TABLE events ADD COLUMN starred INTEGER DEFAULT 0");
      this.db.run("CREATE INDEX IF NOT EXISTS idx_events_starred ON events(starred)");
    }
    /** 表达式索引：加速 json_extract(detail, '$.trackId') 查询 */
    try {
      this.db.run("CREATE INDEX IF NOT EXISTS idx_events_track_id ON events(json_extract(detail, '$.trackId')) WHERE json_extract(detail, '$.trackId') IS NOT NULL");
    } catch { /* 旧版 SQLite 可能不支持表达式索引 */ }
  }

  /** 插入事件 */
  insert(type: string, cameraId: string, timestamp: number, detail?: string): number {
    const result = this.db.query(
      "INSERT INTO events (type, camera_id, timestamp, detail) VALUES (?, ?, ?, ?) RETURNING id"
    ).get(type, cameraId, timestamp, detail ?? null);
    return (result as { id: number }).id;
  }

  /**
   * 批量插入事件（使用显式事务，减少 fsync 开销）
   * 适用于同一检测周期内产生多个事件的场景
   */
  insertMany(events: Array<{ type: string; cameraId: string; timestamp: number; detail?: string }>): void {
    if (events.length === 0) return;
    const stmt = this.db.prepare("INSERT INTO events (type, camera_id, timestamp, detail) VALUES (?, ?, ?, ?)");
    this.db.transaction(() => {
      for (const e of events) {
        stmt.run(e.type, e.cameraId, e.timestamp, e.detail ?? null);
      }
    })();
  }

  /** 查询事件列表（带总数，单次 SQL） */
  queryWithTotal(options: {
    type?: string;
    typeLike?: string;
    cameraId?: string;
    since?: number;
    until?: number;
    limit?: number;
    offset?: number;
    search?: string;
    starred?: boolean;
    trackId?: number;
  } = {}): { rows: EventRecord[]; total: number } {
    const { conditions, params } = this.buildConditions(options);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    /** 使用 CTE + window function 合并 query + count 为单次查询 */
    const rows = this.db.query(
      `SELECT *, COUNT(*) OVER() as _total FROM events ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as Array<EventRecord & { _total: number }>;

    const total = rows.length > 0 ? rows[0]!._total : 0;
    /** 移除 _total 字段 */
    const cleanRows = rows.map(({ _total, ...rest }) => rest) as EventRecord[];
    return { rows: cleanRows, total };
  }

  /** 查询事件列表（不带总数，用于内部查询） */
  query(options: Parameters<EventStorage["queryWithTotal"]>[0] = {}): EventRecord[] {
    const { conditions, params } = this.buildConditions(options);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    return this.db.query(
      `SELECT * FROM events ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as EventRecord[];
  }

  /** 统计事件数量 */
  count(options: { type?: string; typeLike?: string; cameraId?: string; since?: number; until?: number; search?: string; starred?: boolean; trackId?: number } = {}): number {
    const { conditions, params } = this.buildConditions(options);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = this.db.query(`SELECT COUNT(*) as count FROM events ${where}`).get(...params) as { count: number };
    return result.count;
  }

  /** 根据 ID 获取单条事件 */
  getById(id: number): EventRecord | null {
    return this.db.query("SELECT * FROM events WHERE id = ?").get(id) as EventRecord | null;
  }

  /** 切换事件收藏状态 */
  toggleStar(id: number): boolean {
    const row = this.db.query("SELECT starred FROM events WHERE id = ?").get(id) as { starred: number } | null;
    if (!row) return false;
    const newVal = row.starred ? 0 : 1;
    this.db.run("UPDATE events SET starred = ? WHERE id = ?", [newVal, id]);
    return newVal === 1;
  }

  /** 删除过期事件（分批删除避免长事务锁） */
  purge(beforeTimestamp: number): number {
    let total = 0;
    const BATCH = 5000;
    for (;;) {
      const result = this.db.run(
        "DELETE FROM events WHERE id IN (SELECT id FROM events WHERE timestamp < ? LIMIT ?)",
        [beforeTimestamp, BATCH],
      );
      total += result.changes;
      if (result.changes < BATCH) break;
    }
    return total;
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

  /**
   * 按检测目标标签统计（从 detect 事件的 detail JSON 中提取）
   * 兼容新格式 {labels: {person: 2}} 和旧格式 {detections: [{label: "person"}, ...]}
   */
  countByDetectionLabel(options: { since?: number; until?: number } = {}): Array<{ label: string; count: number }> {
    const { conditions, params } = this.buildConditions({ ...options, type: "detect" });
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    try {
      /** 新格式：从 labels object 的 keys + values 汇总 */
      const newRows = this.db.query(
        `SELECT json_each.key as label, SUM(json_each.value) as count FROM events, json_each(json_extract(detail, '$.labels')) ${where} GROUP BY json_each.key ORDER BY count DESC LIMIT 20`
      ).all(...params) as Array<{ label: string; count: number }>;
      if (newRows.length > 0) return newRows;

      /** 回退旧格式 */
      return this.db.query(
        `SELECT json_extract(j.value, '$.label') as label, COUNT(*) as count FROM events, json_each(json_extract(detail, '$.detections')) AS j ${where} GROUP BY label ORDER BY count DESC LIMIT 20`
      ).all(...params) as Array<{ label: string; count: number }>;
    } catch {
      return [];
    }
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

  /**
   * 批量统计所有追踪目标的行为事件数量
   * 使用 SQLite json_extract 直接在 SQL 层聚合，避免全量加载到 JS 内存
   */
  countByTrackId(): Map<number, number> {
    const result = new Map<number, number>();
    try {
      const rows = this.db.query(
        `SELECT json_extract(detail, '$.trackId') as tid, COUNT(*) as cnt
         FROM events WHERE type LIKE 'track:%' AND json_extract(detail, '$.trackId') IS NOT NULL
         GROUP BY tid`
      ).all() as Array<{ tid: number; cnt: number }>;
      for (const row of rows) {
        result.set(row.tid, row.cnt);
      }
    } catch { /* ignore parse errors */ }
    return result;
  }

  /**
   * 按区域聚合统计事件（enter-zone / leave-zone / dwell / loiter / line-cross）
   * 单次查询取出所有 track:% 类型事件，内存中按类型和区域聚合
   */
  zoneStats(options: { cameraId?: string; since?: number; until?: number } = {}): Array<{
    zoneId: number;
    zoneName: string;
    enters: number;
    leaves: number;
    dwells: number;
    loiters: number;
    lineCrosses: number;
    totalDwellMs: number;
    avgDwellMs: number;
  }> {
    const zoneMap = new Map<string, {
      zoneId: number; zoneName: string;
      enters: number; leaves: number; dwells: number; loiters: number; lineCrosses: number;
      totalDwellMs: number; dwellCount: number;
    }>();

    const targetTypes = new Set(["track:enter-zone", "track:leave-zone", "track:dwell", "track:loiter", "track:line-cross"]);
    /** 默认只统计最近 24 小时，避免全表扫描 */
    const since = options.since ?? (Date.now() - 86_400_000);
    const { conditions, params } = this.buildConditions({ ...options, since, typeLike: "track:%" });
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db.query(
      `SELECT type, detail FROM events ${where}`
    ).all(...params) as Array<{ type: string; detail: string | null }>;

    for (const row of rows) {
      if (!targetTypes.has(row.type) || !row.detail) continue;
      const d = JSON.parse(row.detail) as {
        zoneId?: number; zoneName?: string; dwellMs?: number;
        lineId?: number; lineName?: string;
      };
      const isLineCross = row.type === "track:line-cross";
      const zId = isLineCross ? d.lineId : d.zoneId;
      const zName = isLineCross ? d.lineName : d.zoneName;
      if (zId == null || !zName) continue;

      const key = `${zId}:${zName}`;
      if (!zoneMap.has(key)) {
        zoneMap.set(key, { zoneId: zId, zoneName: zName, enters: 0, leaves: 0, dwells: 0, loiters: 0, lineCrosses: 0, totalDwellMs: 0, dwellCount: 0 });
      }
      const entry = zoneMap.get(key)!;
      if (row.type === "track:enter-zone") entry.enters++;
      else if (row.type === "track:leave-zone") { entry.leaves++; if (d.dwellMs) { entry.totalDwellMs += d.dwellMs; entry.dwellCount++; } }
      else if (row.type === "track:dwell") { entry.dwells++; if (d.dwellMs) { entry.totalDwellMs += d.dwellMs; entry.dwellCount++; } }
      else if (row.type === "track:loiter") entry.loiters++;
      else if (row.type === "track:line-cross") entry.lineCrosses++;
    }

    return Array.from(zoneMap.values())
      .map(e => ({
        zoneId: e.zoneId, zoneName: e.zoneName,
        enters: e.enters, leaves: e.leaves, dwells: e.dwells,
        loiters: e.loiters, lineCrosses: e.lineCrosses,
        totalDwellMs: e.totalDwellMs,
        avgDwellMs: e.dwellCount > 0 ? Math.round(e.totalDwellMs / e.dwellCount) : 0,
      }))
      .sort((a, b) => b.enters - a.enters);
  }

  /** 关闭数据库 */
  close(): void {
    this.db.close();
  }

  /** 构建查询条件 */
  private buildConditions(options: { type?: string; typeLike?: string; cameraId?: string; since?: number; until?: number; search?: string; starred?: boolean; trackId?: number }): { conditions: string[]; params: SQLQueryBindings[] } {
    const conditions: string[] = [];
    const params: SQLQueryBindings[] = [];

    if (options.type) {
      conditions.push("type = ?");
      params.push(options.type);
    }
    if (options.typeLike) {
      conditions.push("type LIKE ?");
      params.push(options.typeLike);
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
    if (options.starred) {
      conditions.push("starred = 1");
    }
    if (options.trackId != null) {
      /** 从 detail JSON 中提取 trackId（SQLite json_extract，精确匹配） */
      conditions.push("json_extract(detail, '$.trackId') = ?");
      params.push(options.trackId);
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
  starred?: number;
}
