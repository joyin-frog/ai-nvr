import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** 检测规则 */
export interface DetectRule {
  id: number;
  /** 规则名称 */
  name: string;
  /** 摄像头 ID（必选） */
  cameraId: string;
  /** ROI 区域 ID（0=不限制） */
  roiId: number;
  /** 用户提示词 */
  prompt: string;
  /** 检测间隔（毫秒） */
  intervalMs: number;
  /** 冷却时间（毫秒） */
  cooldownMs: number;
  /** 是否启用 */
  enabled: boolean;
}

/** 检测规则匹配记录 */
export interface DetectRuleRecord {
  id: number;
  /** 规则 ID */
  ruleId: number;
  /** 规则名称快照 */
  ruleName: string;
  /** 摄像头 ID */
  cameraId: string;
  /** 检测时间 */
  timestamp: number;
  /** VLM 分析结果 */
  result: string;
  /** 是否匹配 */
  matched: boolean;
  /** 详细信息 JSON */
  detail: string;
}

/**
 * 检测规则存储
 */
export class DetectRuleStorage {
  private db: Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA wal_autocheckpoint = 1000");

    this.db.run(`
      CREATE TABLE IF NOT EXISTS detect_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        camera_id TEXT NOT NULL,
        roi_id INTEGER NOT NULL DEFAULT 0,
        prompt TEXT NOT NULL,
        interval_ms INTEGER NOT NULL DEFAULT 5000,
        cooldown_ms INTEGER NOT NULL DEFAULT 30000,
        enabled INTEGER NOT NULL DEFAULT 1
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS detect_rule_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_id INTEGER NOT NULL,
        rule_name TEXT NOT NULL,
        camera_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        result TEXT NOT NULL DEFAULT '',
        matched INTEGER NOT NULL DEFAULT 0,
        detail TEXT,
        FOREIGN KEY (rule_id) REFERENCES detect_rules(id)
      )
    `);

    this.db.run("CREATE INDEX IF NOT EXISTS idx_detect_rule_records_timestamp ON detect_rule_records(timestamp)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_detect_rule_records_rule ON detect_rule_records(rule_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_detect_rule_records_camera_time ON detect_rule_records(camera_id, timestamp)");
  }

  /** 获取所有规则 */
  listRules(): DetectRule[] {
    return this.db.query(
      "SELECT id, name, camera_id as cameraId, roi_id as roiId, prompt, interval_ms as intervalMs, cooldown_ms as cooldownMs, enabled FROM detect_rules ORDER BY id"
    ).all() as DetectRule[];
  }

  /** 获取启用的规则 */
  getEnabledRules(): DetectRule[] {
    return this.db.query(
      "SELECT id, name, camera_id as cameraId, roi_id as roiId, prompt, interval_ms as intervalMs, cooldown_ms as cooldownMs, enabled FROM detect_rules WHERE enabled = 1"
    ).all() as DetectRule[];
  }

  /** 添加规则 */
  addRule(rule: Omit<DetectRule, "id" | "enabled">): number {
    const result = this.db.query(
      "INSERT INTO detect_rules (name, camera_id, roi_id, prompt, interval_ms, cooldown_ms, enabled) VALUES (?, ?, ?, ?, ?, ?, 1) RETURNING id"
    ).get(rule.name, rule.cameraId, rule.roiId ?? 0, rule.prompt, rule.intervalMs, rule.cooldownMs);
    return (result as { id: number }).id;
  }

  /** 更新规则 */
  updateRule(id: number, updates: Partial<Pick<DetectRule, "name" | "cameraId" | "roiId" | "prompt" | "intervalMs" | "cooldownMs" | "enabled">>): boolean {
    const sets: string[] = [];
    const params: (string | number)[] = [];

    if (updates.name !== undefined) { sets.push("name = ?"); params.push(updates.name); }
    if (updates.cameraId !== undefined) { sets.push("camera_id = ?"); params.push(updates.cameraId); }
    if (updates.roiId !== undefined) { sets.push("roi_id = ?"); params.push(updates.roiId); }
    if (updates.prompt !== undefined) { sets.push("prompt = ?"); params.push(updates.prompt); }
    if (updates.intervalMs !== undefined) { sets.push("interval_ms = ?"); params.push(updates.intervalMs); }
    if (updates.cooldownMs !== undefined) { sets.push("cooldown_ms = ?"); params.push(updates.cooldownMs); }
    if (updates.enabled !== undefined) { sets.push("enabled = ?"); params.push(updates.enabled ? 1 : 0); }

    if (sets.length === 0) return false;
    params.push(id);

    const result = this.db.run(
      `UPDATE detect_rules SET ${sets.join(", ")} WHERE id = ?`,
      params
    );
    return result.changes > 0;
  }

  /** 删除规则 */
  removeRule(id: number): boolean {
    const result = this.db.run("DELETE FROM detect_rules WHERE id = ?", [id]);
    return result.changes > 0;
  }

  /** 记录检测结果 */
  insertRecord(ruleId: number, ruleName: string, cameraId: string, timestamp: number, result: string, matched: boolean, detail: string): number {
    const row = this.db.query(
      "INSERT INTO detect_rule_records (rule_id, rule_name, camera_id, timestamp, result, matched, detail) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id"
    ).get(ruleId, ruleName, cameraId, timestamp, result, matched ? 1 : 0, detail);
    return (row as { id: number }).id;
  }

  /** 查询检测记录 */
  queryRecords(options: {
    cameraId?: string;
    since?: number;
    until?: number;
    matched?: boolean;
    limit?: number;
    offset?: number;
  } = {}): DetectRuleRecord[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (options.cameraId) { conditions.push("camera_id = ?"); params.push(options.cameraId); }
    if (options.since) { conditions.push("timestamp >= ?"); params.push(options.since); }
    if (options.until) { conditions.push("timestamp <= ?"); params.push(options.until); }
    if (options.matched !== undefined) { conditions.push("matched = ?"); params.push(options.matched ? 1 : 0); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    return this.db.query(
      `SELECT id, rule_id as ruleId, rule_name as ruleName, camera_id as cameraId, timestamp, result, matched, detail FROM detect_rule_records ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as DetectRuleRecord[];
  }

  /** 查询记录数量 */
  countRecords(options: { cameraId?: string; since?: number; until?: number; matched?: boolean } = {}): number {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (options.cameraId) { conditions.push("camera_id = ?"); params.push(options.cameraId); }
    if (options.since) { conditions.push("timestamp >= ?"); params.push(options.since); }
    if (options.until) { conditions.push("timestamp <= ?"); params.push(options.until); }
    if (options.matched !== undefined) { conditions.push("matched = ?"); params.push(options.matched ? 1 : 0); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const row = this.db.query(`SELECT COUNT(*) as count FROM detect_rule_records ${where}`).get(...params) as { count: number };
    return row.count;
  }

  /** 清理过期记录 */
  purge(beforeTimestamp: number): number {
    const result = this.db.run("DELETE FROM detect_rule_records WHERE timestamp < ?", [beforeTimestamp]);
    return result.changes;
  }

  /** 删除所有记录 */
  purgeAll(): number {
    const count = (this.db.query("SELECT COUNT(*) as cnt FROM detect_rule_records").get() as { cnt: number }).cnt;
    this.db.run("DELETE FROM detect_rule_records");
    return count;
  }

  /** 关闭数据库 */
  close(): void {
    this.db.close();
  }
}
