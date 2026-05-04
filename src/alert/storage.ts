import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { type EventSubscription } from "@/alert/matcher";
import { type AlertAction } from "@/alert/action";

/** 告警规则（重构后） */
export interface AlertRule {
  id: number;
  /** 规则名称 */
  name: string;
  /** 事件订阅 */
  subscription: EventSubscription;
  /** 条件表达式 JSON（空=无条件） */
  condition: string;
  /** 时间窗口（秒） */
  windowSeconds: number;
  /** 窗口内触发次数阈值 */
  threshold: number;
  /** 冷却时间（秒） */
  cooldownSeconds: number;
  /** 触发后执行的动作列表 */
  actions: AlertAction[];
  /** 是否启用 */
  enabled: boolean;
  /** 静默时段开始（HH:MM） */
  silentStart: string;
  /** 静默时段结束（HH:MM） */
  silentEnd: string;
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

/** 数据库原始行 */
interface DbRow {
  id: number;
  name: string;
  subscriptionJson: string;
  condition: string;
  windowSeconds: number;
  threshold: number;
  cooldownSeconds: number;
  actionsJson: string;
  enabled: number;
  silentStart: string;
  silentEnd: string;
}

/**
 * 告警规则与记录存储（重构后）
 */
export class AlertStorage {
  private db: Database;
  private stmtGetEnabled: ReturnType<Database["prepare"]>;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = NORMAL");
    this.db.run("PRAGMA busy_timeout = 5000");
    this.db.run("PRAGMA wal_autocheckpoint = 1000");

    this.db.run(`
      CREATE TABLE IF NOT EXISTS alert_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        subscription TEXT NOT NULL DEFAULT '{}',
        condition TEXT NOT NULL DEFAULT '',
        window_seconds INTEGER NOT NULL DEFAULT 60,
        threshold INTEGER NOT NULL DEFAULT 3,
        cooldown_seconds INTEGER NOT NULL DEFAULT 300,
        actions TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 1,
        silent_start TEXT NOT NULL DEFAULT '',
        silent_end TEXT NOT NULL DEFAULT ''
      )
    `);

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

    /** 从旧 alert_rules 表迁移 */
    this.migrateFromLegacy();

    this.stmtGetEnabled = this.db.prepare(
      `SELECT id, name, subscription as subscriptionJson, condition,
        window_seconds as windowSeconds, threshold, cooldown_seconds as cooldownSeconds,
        actions as actionsJson, enabled, silent_start as silentStart, silent_end as silentEnd
      FROM alert_rules WHERE enabled = 1`
    );
  }

  /** 从旧 alert_rules 表迁移（旧表有不同列结构） */
  private migrateFromLegacy(): void {
    const cols = this.db.query("PRAGMA table_info(alert_rules)").all() as Array<{ name: string }>;
    const colNames = new Set(cols.map(c => c.name));

    /** 如果新列不存在，添加 */
    if (!colNames.has("subscription")) {
      this.db.run("ALTER TABLE alert_rules ADD COLUMN subscription TEXT NOT NULL DEFAULT '{}'");
    }
    if (!colNames.has("actions")) {
      this.db.run("ALTER TABLE alert_rules ADD COLUMN actions TEXT NOT NULL DEFAULT '[]'");
    }

    /** 迁移旧格式数据：从 eventType/sourceRuleId/sourceStateId 构建 subscription JSON */
    if (colNames.has("event_type") && colNames.has("source_rule_id")) {
      const legacyRules = this.db.query(
        `SELECT id, event_type, source_rule_id, source_state_id, camera_id, condition FROM alert_rules WHERE subscription = '{}'`
      ).all() as Array<{ id: number; event_type: string; source_rule_id: number; source_state_id: number; camera_id: string; condition: string }>;

      for (const row of legacyRules) {
        /** 映射旧事件类型名到新名 */
        let eventType = row.event_type;
        if (eventType === "detect:rule") eventType = "observation";
        if (eventType === "state:changed") eventType = "signal:changed";

        /** 确定 sourceId */
        const sourceId = row.event_type === "detect:rule" ? row.source_rule_id : row.source_state_id;

        const subscription = JSON.stringify({
          eventType,
          sourceId: sourceId ?? 0,
          cameraId: row.camera_id ?? "",
        });

        this.db.run(
          "UPDATE alert_rules SET subscription = ? WHERE id = ?",
          [subscription, row.id],
        );
      }

      if (legacyRules.length > 0) {
        console.log(`[AlertStorage] 从旧格式迁移了 ${legacyRules.length} 条告警规则`);
      }
    }
  }

  /** 获取所有规则 */
  listRules(): AlertRule[] {
    return (this.db.query(
      `SELECT id, name, subscription as subscriptionJson, condition,
        window_seconds as windowSeconds, threshold, cooldown_seconds as cooldownSeconds,
        actions as actionsJson, enabled, silent_start as silentStart, silent_end as silentEnd
      FROM alert_rules ORDER BY id`
    ).all() as DbRow[]).map(this.mapRow);
  }

  /** 获取启用的规则 */
  getEnabledRules(): AlertRule[] {
    return (this.stmtGetEnabled.all() as DbRow[]).map(this.mapRow);
  }

  /** 添加规则 */
  addRule(rule: Omit<AlertRule, "id" | "enabled">): number {
    const row = this.db.query(
      `INSERT INTO alert_rules (name, subscription, condition, window_seconds, threshold, cooldown_seconds, actions, enabled, silent_start, silent_end)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?) RETURNING id`
    ).get(
      rule.name,
      JSON.stringify(rule.subscription),
      rule.condition ?? "",
      rule.windowSeconds, rule.threshold, rule.cooldownSeconds,
      JSON.stringify(rule.actions ?? []),
      rule.silentStart ?? "", rule.silentEnd ?? "",
    );
    return (row as { id: number }).id;
  }

  /** 更新规则 */
  updateRule(id: number, updates: Partial<Omit<AlertRule, "id">>): boolean {
    const sets: string[] = [];
    const params: (string | number)[] = [];

    if (updates.name !== undefined) { sets.push("name = ?"); params.push(updates.name); }
    if (updates.subscription !== undefined) { sets.push("subscription = ?"); params.push(JSON.stringify(updates.subscription)); }
    if (updates.condition !== undefined) { sets.push("condition = ?"); params.push(updates.condition); }
    if (updates.windowSeconds !== undefined) { sets.push("window_seconds = ?"); params.push(updates.windowSeconds); }
    if (updates.threshold !== undefined) { sets.push("threshold = ?"); params.push(updates.threshold); }
    if (updates.cooldownSeconds !== undefined) { sets.push("cooldown_seconds = ?"); params.push(updates.cooldownSeconds); }
    if (updates.actions !== undefined) { sets.push("actions = ?"); params.push(JSON.stringify(updates.actions)); }
    if (updates.enabled !== undefined) { sets.push("enabled = ?"); params.push(updates.enabled ? 1 : 0); }
    if (updates.silentStart !== undefined) { sets.push("silent_start = ?"); params.push(updates.silentStart); }
    if (updates.silentEnd !== undefined) { sets.push("silent_end = ?"); params.push(updates.silentEnd); }

    if (sets.length === 0) return false;
    params.push(id);

    const result = this.db.run(
      `UPDATE alert_rules SET ${sets.join(", ")} WHERE id = ?`,
      params,
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
    const row = this.db.query(
      "INSERT INTO alert_records (rule_id, rule_name, camera_id, timestamp, detail) VALUES (?, ?, ?, ?, ?) RETURNING id"
    ).get(ruleId, ruleName, cameraId, timestamp, detail);
    return (row as { id: number }).id;
  }

  /** 查询告警历史 */
  queryAlerts(options: {
    cameraId?: string;
    since?: number;
    until?: number;
    limit?: number;
    offset?: number;
  } = {}): { records: AlertRecord[]; total: number } {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (options.cameraId) { conditions.push("camera_id = ?"); params.push(options.cameraId); }
    if (options.since) { conditions.push("timestamp >= ?"); params.push(options.since); }
    if (options.until) { conditions.push("timestamp <= ?"); params.push(options.until); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    const total = (this.db.query(`SELECT COUNT(*) as count FROM alert_records ${where}`).get(...params) as { count: number }).count;
    const records = this.db.query(
      `SELECT id, rule_id as ruleId, rule_name as ruleName, camera_id as cameraId, timestamp, detail FROM alert_records ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as AlertRecord[];

    return { records, total };
  }

  /** 删除所有告警记录 */
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

  /** 数据库行映射 */
  private mapRow(row: DbRow): AlertRule {
    let subscription: EventSubscription;
    try {
      subscription = JSON.parse(row.subscriptionJson) as EventSubscription;
    } catch (e) {
      console.warn("[AlertStorage] JSON parse failed for subscription, ruleId:", row.id, e);
      subscription = { eventType: "observation", sourceId: 0, cameraId: "" };
    }

    let actions: AlertAction[] = [];
    try {
      actions = JSON.parse(row.actionsJson ?? "[]") as AlertAction[];
    } catch (e) {
      console.warn("[AlertStorage] JSON parse failed for actions, ruleId:", row.id, e);
    }

    return {
      id: row.id,
      name: row.name,
      subscription,
      condition: row.condition ?? "",
      windowSeconds: row.windowSeconds,
      threshold: row.threshold,
      cooldownSeconds: row.cooldownSeconds,
      actions,
      enabled: !!row.enabled,
      silentStart: row.silentStart ?? "",
      silentEnd: row.silentEnd ?? "",
    };
  }

  close(): void {
    this.db.close();
  }
}
