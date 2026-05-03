import { Database, type SQLQueryBindings } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** 事件记录 */
export interface EventRecord {
  id: number;
  type: string;
  camera_id: string;
  timestamp: number;
  detail: string | null;
  starred?: number;
}

/** 事件持久化存储 */
export class EventStorage {
  private db: Database;
  /** 预编译高频语句 */
  private stmtInsert: ReturnType<Database["prepare"]>;
  private stmtGetById: ReturnType<Database["prepare"]>;
  private stmtGetStar: ReturnType<Database["prepare"]>;
  private stmtUpdateStar: ReturnType<Database["prepare"]>;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = NORMAL");
    this.db.run("PRAGMA busy_timeout = 5000");
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

    /** 预编译高频 SQL 语句（避免每次调用重新解析 SQL） */
    this.stmtInsert = this.db.prepare("INSERT INTO events (type, camera_id, timestamp, detail) VALUES (?, ?, ?, ?) RETURNING id");
    this.stmtGetById = this.db.prepare("SELECT * FROM events WHERE id = ?");
    this.stmtGetStar = this.db.prepare("SELECT starred FROM events WHERE id = ?");
    this.stmtUpdateStar = this.db.prepare("UPDATE events SET starred = ? WHERE id = ?");
  }

  /** 插入事件 */
  insert(type: string, cameraId: string, timestamp: number, detail?: string): number {
    const result = this.stmtInsert.get(type, cameraId, timestamp, detail ?? null);
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

  /** 查询事件列表（带总数，分离 COUNT + SELECT 避免窗口函数全量扫描） */
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

    /** 分离查询：COUNT 走索引覆盖，SELECT + LIMIT 只取需要的行 */
    const countRow = this.db.query(
      `SELECT COUNT(*) as cnt FROM events ${where}`
    ).get(...params) as { cnt: number };
    const total = countRow.cnt;

    if (total === 0) return { rows: [], total: 0 };

    const rows = this.db.query(
      `SELECT * FROM events ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as EventRecord[];

    return { rows, total };
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
    return this.stmtGetById.get(id) as EventRecord | null;
  }

  /** 切换事件收藏状态 */
  toggleStar(id: number): boolean {
    const row = this.stmtGetStar.get(id) as { starred: number } | null;
    if (!row) return false;
    const newVal = row.starred ? 0 : 1;
    this.stmtUpdateStar.run(newVal, id);
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
   * 使用 SQLite json_extract 直接在 SQL 层聚合，避免全量加载到 JS 内存
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
    /** 默认只统计最近 24 小时，避免全表扫描 */
    const since = options.since ?? (Date.now() - 86_400_000);

    /** 区域类事件（zoneId + zoneName） */
    const { conditions: zCond, params: zParams } = this.buildConditions({
      ...options,
      since,
      typeLike: "track:%",
    });
    const zoneTypes = ["track:enter-zone", "track:leave-zone", "track:dwell", "track:loiter"];
    const zWhere = zCond.length > 0 ? `AND ${zCond.join(" AND ")}` : "";
    const zoneRows = this.db.query(
      `SELECT type,
         json_extract(detail, '$.zoneId') as zoneId,
         json_extract(detail, '$.zoneName') as zoneName,
         SUM(CASE WHEN type = 'track:enter-zone' THEN 1 ELSE 0 END) as enters,
         SUM(CASE WHEN type = 'track:leave-zone' THEN 1 ELSE 0 END) as leaves,
         SUM(CASE WHEN type = 'track:dwell' THEN 1 ELSE 0 END) as dwells,
         SUM(CASE WHEN type = 'track:loiter' THEN 1 ELSE 0 END) as loiters,
         SUM(CASE WHEN type IN ('track:leave-zone', 'track:dwell') THEN json_extract(detail, '$.dwellMs') ELSE 0 END) as totalDwellMs,
         SUM(CASE WHEN type IN ('track:leave-zone', 'track:dwell') AND json_extract(detail, '$.dwellMs') > 0 THEN 1 ELSE 0 END) as dwellCount
       FROM events
       WHERE type IN (${zoneTypes.map(() => '?').join(',')})
         AND json_extract(detail, '$.zoneId') IS NOT NULL
         ${zWhere}
       GROUP BY zoneId, zoneName
       ORDER BY enters DESC`
    ).all(...zoneTypes, ...zParams) as Array<{
      zoneId: number; zoneName: string;
      enters: number; leaves: number; dwells: number; loiters: number;
      totalDwellMs: number; dwellCount: number;
    }>;

    /** 越线类事件（lineId + lineName） */
    const { conditions: lCond, params: lParams } = this.buildConditions({
      ...options,
      since,
      type: "track:line-cross",
    });
    const lWhere = lCond.length > 0 ? `AND ${lCond.join(" AND ")}` : "";
    const lineRows = this.db.query(
      `SELECT
         json_extract(detail, '$.lineId') as zoneId,
         json_extract(detail, '$.lineName') as zoneName,
         COUNT(*) as lineCrosses
       FROM events
       WHERE json_extract(detail, '$.lineId') IS NOT NULL
         ${lWhere}
       GROUP BY zoneId, zoneName`
    ).all(...lParams) as Array<{
      zoneId: number; zoneName: string; lineCrosses: number;
    }>;

    /** 合并区域和越线统计 */
    const lineMap = new Map(lineRows.map(r => [`${r.zoneId}:${r.zoneName}`, r.lineCrosses]));
    return zoneRows.map(r => ({
      zoneId: r.zoneId,
      zoneName: r.zoneName,
      enters: r.enters,
      leaves: r.leaves,
      dwells: r.dwells,
      loiters: r.loiters,
      lineCrosses: lineMap.get(`${r.zoneId}:${r.zoneName}`) ?? 0,
      totalDwellMs: r.totalDwellMs,
      avgDwellMs: r.dwellCount > 0 ? Math.round(r.totalDwellMs / r.dwellCount) : 0,
    }));
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

  /**
   * 计算事件异常评分
   * 比较当前窗口的事件数与过去 N 个同窗口的历史平均
   * 返回 0-1 的异常分数（越高越异常）
   */
  getAnomalyScore(options: { type: string; cameraId?: string; windowMs?: number }): { score: number; current: number; baseline: number } {
    const windowMs = options.windowMs ?? 300_000;
    const now = Date.now();
    const currentStart = now - windowMs;

    /** 当前窗口事件数 */
    const current = this.count({ type: options.type, cameraId: options.cameraId, since: currentStart, until: now });

    /** 过去 24 小时内同类型同窗口的平均事件数（取 6 个窗口样本） */
    const samples = 6;
    let totalHistorical = 0;
    let validSamples = 0;
    for (let i = 1; i <= samples; i++) {
      const sampleStart = now - windowMs * (i + 1);
      const sampleEnd = now - windowMs * i;
      const count = this.count({ type: options.type, cameraId: options.cameraId, since: sampleStart, until: sampleEnd });
      totalHistorical += count;
      validSamples++;
    }
    const baseline = validSamples > 0 ? totalHistorical / validSamples : 0;

    /** 异常评分：当前值超过平均 2 倍时开始计分，最高 1.0 */
    if (baseline === 0) return { score: current > 0 ? 0.5 : 0, current, baseline };
    const ratio = current / baseline;
    const score = Math.min(1, Math.max(0, (ratio - 2) / 3));
    return { score, current, baseline: Math.round(baseline * 10) / 10 };
  }
}
