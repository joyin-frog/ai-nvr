import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** 告警规则 */
export interface AlertRule {
  id: number;
  /** 规则名称 */
  name: string;
  /** 监听的事件类型：motion / detect / camera:offline */
  eventType: string;
  /** 限定摄像头 ID，空字符串表示所有 */
  cameraId: string;
  /** 标签过滤（仅 detect 事件），逗号分隔，空表示不过滤 */
  labels: string;
  /** 追踪命名过滤（仅 detect 事件），逗号分隔用户命名，空表示不过滤 */
  trackNames: string;
  /** 时间窗口（秒） */
  windowSeconds: number;
  /** 窗口内触发次数阈值 */
  threshold: number;
  /** 冷却时间（秒）：告警触发后的最小间隔 */
  cooldownSeconds: number;
  /** 是否启用 */
  enabled: boolean;
  /** 静默时段开始（HH:MM 格式，如 "22:00"），空表示无静默 */
  silentStart: string;
  /** 静默时段结束（HH:MM 格式，如 "06:00"） */
  silentEnd: string;
  /** 单次检测中匹配标签的最少目标数量（0=不限制） */
  minCount: number;
  /** ROI 区域 ID（0=不限制区域） */
  roiId: number;
  /** 最小速度阈值（仅 track:speed 事件，m/s，0=不限制） */
  minSpeed: number;
}

/** 告警记录 */
export interface AlertRecord {
  id: number;
  /** 触发的规则 ID */
  ruleId: number;
  /** 规则名称快照 */
  ruleName: string;
  /** 摄像头 ID */
  cameraId: string;
  /** 触发时间 */
  timestamp: number;
  /** 触发详情 JSON */
  detail: string;
}

/**
 * 告警规则与记录存储
 */
export class AlertStorage {
  private db: Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA wal_autocheckpoint = 1000");

    this.db.run(`
      CREATE TABLE IF NOT EXISTS alert_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        event_type TEXT NOT NULL,
        camera_id TEXT NOT NULL DEFAULT '',
        labels TEXT NOT NULL DEFAULT '',
        track_names TEXT NOT NULL DEFAULT '',
        window_seconds INTEGER NOT NULL DEFAULT 60,
        threshold INTEGER NOT NULL DEFAULT 3,
        cooldown_seconds INTEGER NOT NULL DEFAULT 300,
        enabled INTEGER NOT NULL DEFAULT 1,
        silent_start TEXT NOT NULL DEFAULT '',
        silent_end TEXT NOT NULL DEFAULT '',
        min_count INTEGER NOT NULL DEFAULT 0
      )
    `);

    /** 迁移：为已有表添加缺失列 */
    const cols = this.db.query("PRAGMA table_info(alert_rules)").all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === "min_count")) {
      this.db.run("ALTER TABLE alert_rules ADD COLUMN min_count INTEGER NOT NULL DEFAULT 0");
    }
    if (!cols.some(c => c.name === "track_names")) {
      this.db.run("ALTER TABLE alert_rules ADD COLUMN track_names TEXT NOT NULL DEFAULT ''");
    }
    if (!cols.some(c => c.name === "roi_id")) {
      this.db.run("ALTER TABLE alert_rules ADD COLUMN roi_id INTEGER NOT NULL DEFAULT 0");
    }
    if (!cols.some(c => c.name === "min_speed")) {
      this.db.run("ALTER TABLE alert_rules ADD COLUMN min_speed REAL NOT NULL DEFAULT 0");
    }

    this.db.run(`
      CREATE TABLE IF NOT EXISTS alert_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_id INTEGER NOT NULL,
        rule_name TEXT NOT NULL,
        camera_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        detail TEXT,
        FOREIGN KEY (rule_id) REFERENCES alert_rules(id)
      )
    `);

    this.db.run("CREATE INDEX IF NOT EXISTS idx_alert_records_timestamp ON alert_records(timestamp)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_alert_records_rule ON alert_records(rule_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_alert_records_camera_time ON alert_records(camera_id, timestamp)");
  }

  /** 获取所有规则 */
  listRules(): AlertRule[] {
    return this.db.query(
      "SELECT id, name, event_type as eventType, camera_id as cameraId, labels, track_names as trackNames, window_seconds as windowSeconds, threshold, cooldown_seconds as cooldownSeconds, enabled, silent_start as silentStart, silent_end as silentEnd, min_count as minCount, roi_id as roiId, min_speed as minSpeed FROM alert_rules ORDER BY id"
    ).all() as AlertRule[];
  }

  /** 获取启用的规则 */
  getEnabledRules(): AlertRule[] {
    return this.db.query(
      "SELECT id, name, event_type as eventType, camera_id as cameraId, labels, track_names as trackNames, window_seconds as windowSeconds, threshold, cooldown_seconds as cooldownSeconds, enabled, silent_start as silentStart, silent_end as silentEnd, min_count as minCount, roi_id as roiId, min_speed as minSpeed FROM alert_rules WHERE enabled = 1"
    ).all() as AlertRule[];
  }

  /** 添加规则 */
  addRule(rule: Omit<AlertRule, "id" | "enabled">): number {
    const result = this.db.query(
      "INSERT INTO alert_rules (name, event_type, camera_id, labels, track_names, window_seconds, threshold, cooldown_seconds, enabled, silent_start, silent_end, min_count, roi_id, min_speed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?) RETURNING id"
    ).get(rule.name, rule.eventType, rule.cameraId, rule.labels, rule.trackNames ?? "", rule.windowSeconds, rule.threshold, rule.cooldownSeconds, rule.silentStart ?? "", rule.silentEnd ?? "", rule.minCount ?? 0, rule.roiId ?? 0, rule.minSpeed ?? 0);
    return (result as { id: number }).id;
  }

  /** 更新规则 */
  updateRule(id: number, updates: Partial<Pick<AlertRule, "name" | "eventType" | "cameraId" | "labels" | "trackNames" | "windowSeconds" | "threshold" | "cooldownSeconds" | "enabled" | "silentStart" | "silentEnd" | "minCount" | "roiId" | "minSpeed">>): boolean {
    const sets: string[] = [];
    const params: (string | number)[] = [];

    if (updates.name !== undefined) { sets.push("name = ?"); params.push(updates.name); }
    if (updates.eventType !== undefined) { sets.push("event_type = ?"); params.push(updates.eventType); }
    if (updates.cameraId !== undefined) { sets.push("camera_id = ?"); params.push(updates.cameraId); }
    if (updates.labels !== undefined) { sets.push("labels = ?"); params.push(updates.labels); }
    if (updates.trackNames !== undefined) { sets.push("track_names = ?"); params.push(updates.trackNames); }
    if (updates.windowSeconds !== undefined) { sets.push("window_seconds = ?"); params.push(updates.windowSeconds); }
    if (updates.threshold !== undefined) { sets.push("threshold = ?"); params.push(updates.threshold); }
    if (updates.cooldownSeconds !== undefined) { sets.push("cooldown_seconds = ?"); params.push(updates.cooldownSeconds); }
    if (updates.enabled !== undefined) { sets.push("enabled = ?"); params.push(updates.enabled ? 1 : 0); }
    if (updates.silentStart !== undefined) { sets.push("silent_start = ?"); params.push(updates.silentStart); }
    if (updates.silentEnd !== undefined) { sets.push("silent_end = ?"); params.push(updates.silentEnd); }
    if (updates.minCount !== undefined) { sets.push("min_count = ?"); params.push(updates.minCount); }
    if (updates.roiId !== undefined) { sets.push("roi_id = ?"); params.push(updates.roiId); }
    if (updates.minSpeed !== undefined) { sets.push("min_speed = ?"); params.push(updates.minSpeed); }

    if (sets.length === 0) return false;
    params.push(id);

    const result = this.db.run(
      `UPDATE alert_rules SET ${sets.join(", ")} WHERE id = ?`,
      params
    );
    return result.changes > 0;
  }

  /** 删除规则 */
  removeRule(id: number): boolean {
    const result = this.db.run("DELETE FROM alert_rules WHERE id = ?", [id]);
    return result.changes > 0;
  }

  /** 记录告警 */
  insertAlert(ruleId: number, ruleName: string, cameraId: string, timestamp: number, detail: string): number {
    const result = this.db.query(
      "INSERT INTO alert_records (rule_id, rule_name, camera_id, timestamp, detail) VALUES (?, ?, ?, ?, ?) RETURNING id"
    ).get(ruleId, ruleName, cameraId, timestamp, detail);
    return (result as { id: number }).id;
  }

  /** 查询告警历史 */
  queryAlerts(options: {
    cameraId?: string;
    since?: number;
    until?: number;
    limit?: number;
    offset?: number;
  } = {}): AlertRecord[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (options.cameraId) { conditions.push("camera_id = ?"); params.push(options.cameraId); }
    if (options.since) { conditions.push("timestamp >= ?"); params.push(options.since); }
    if (options.until) { conditions.push("timestamp <= ?"); params.push(options.until); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    return this.db.query(
      `SELECT id, rule_id as ruleId, rule_name as ruleName, camera_id as cameraId, timestamp, detail FROM alert_records ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as AlertRecord[];
  }

  /** 查询告警数量 */
  countAlerts(options: { cameraId?: string; since?: number; until?: number } = {}): number {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (options.cameraId) { conditions.push("camera_id = ?"); params.push(options.cameraId); }
    if (options.since) { conditions.push("timestamp >= ?"); params.push(options.since); }
    if (options.until) { conditions.push("timestamp <= ?"); params.push(options.until); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = this.db.query(`SELECT COUNT(*) as count FROM alert_records ${where}`).get(...params) as { count: number };
    return result.count;
  }

  /** 删除所有告警记录，返回删除的行数 */
  purgeAll(): number {
    const count = (this.db.query("SELECT COUNT(*) as cnt FROM alert_records").get() as { cnt: number }).cnt;
    this.db.run("DELETE FROM alert_records");
    return count;
  }

  /** 清理过期告警记录 */
  purge(beforeTimestamp: number): number {
    const result = this.db.run("DELETE FROM alert_records WHERE timestamp < ?", [beforeTimestamp]);
    return result.changes;
  }

  /** 关闭数据库 */
  close(): void {
    this.db.close();
  }
}
