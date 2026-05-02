import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** 状态定义 */
export interface StateDef {
  id: number;
  /** 状态名称（如"门禁已关闭"） */
  name: string;
  /** 描述 */
  description: string;
  /** 摄像头 ID（空字符串=全局） */
  cameraId: string;
  /** 值类型 */
  valueType: "boolean" | "string" | "number";
  /** 初始值（字符串存储） */
  initialValue: string;
  /** 当前值 */
  currentValue: string;
  /** 变更时是否触发通知 */
  notifyOnChange: boolean;
  /** 是否启用 */
  enabled: boolean;
}

/** 状态变更记录 */
export interface StateChange {
  id: number;
  /** 状态 ID */
  stateId: number;
  /** 状态名称快照 */
  stateName: string;
  /** 摄像头 ID */
  cameraId: string;
  /** 旧值 */
  oldValue: string;
  /** 新值 */
  newValue: string;
  /** 来源（manual / rule:规则ID / system） */
  source: string;
  /** 来源规则 ID（0=手动） */
  sourceRuleId: number;
  /** 变更时间戳 */
  timestamp: number;
}

/**
 * 状态存储
 * 支持创建自定义状态（布尔/字符串/数字），检测规则可关联状态并更新其值
 */
export class StateStorage {
  private db: Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA wal_autocheckpoint = 1000");

    this.db.run(`
      CREATE TABLE IF NOT EXISTS states (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        camera_id TEXT NOT NULL DEFAULT '',
        value_type TEXT NOT NULL DEFAULT 'boolean',
        initial_value TEXT NOT NULL DEFAULT '',
        current_value TEXT NOT NULL DEFAULT '',
        notify_on_change INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS state_changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        state_id INTEGER NOT NULL,
        state_name TEXT NOT NULL,
        camera_id TEXT NOT NULL DEFAULT '',
        old_value TEXT NOT NULL DEFAULT '',
        new_value TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'manual',
        source_rule_id INTEGER NOT NULL DEFAULT 0,
        timestamp INTEGER NOT NULL,
        FOREIGN KEY (state_id) REFERENCES states(id)
      )
    `);

    this.db.run("CREATE INDEX IF NOT EXISTS idx_state_changes_timestamp ON state_changes(timestamp)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_state_changes_state_time ON state_changes(state_id, timestamp)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_state_changes_camera_time ON state_changes(camera_id, timestamp)");
  }

  /** 列出所有状态 */
  listStates(): StateDef[] {
    return this.db.query(`
      SELECT id, name, description, camera_id AS cameraId, value_type AS valueType,
        initial_value AS initialValue, current_value AS currentValue,
        notify_on_change AS notifyOnChange, enabled
      FROM states ORDER BY id
    `).all() as StateDef[];
  }

  /** 获取单个状态 */
  getState(id: number): StateDef | undefined {
    return this.db.query(`
      SELECT id, name, description, camera_id AS cameraId, value_type AS valueType,
        initial_value AS initialValue, current_value AS currentValue,
        notify_on_change AS notifyOnChange, enabled
      FROM states WHERE id = ?
    `).get(id) as StateDef | undefined;
  }

  /** 添加状态 */
  addState(state: Omit<StateDef, "id" | "currentValue">): number {
    const initialValue = state.initialValue ?? this.defaultForType(state.valueType);
    const result = this.db.run(`
      INSERT INTO states (name, description, camera_id, value_type, initial_value, current_value, notify_on_change, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      state.name, state.description, state.cameraId, state.valueType,
      initialValue, initialValue,
      state.notifyOnChange ? 1 : 0,
      state.enabled ? 1 : 0,
    ]);
    return Number(result.lastInsertRowid);
  }

  /** 更新状态定义 */
  updateState(id: number, updates: Partial<Pick<StateDef, "name" | "description" | "cameraId" | "valueType" | "initialValue" | "notifyOnChange" | "enabled">>): boolean {
    const sets: string[] = [];
    const values: (string | number)[] = [];
    const map: Record<string, string> = {
      name: "name", description: "description", cameraId: "camera_id",
      valueType: "value_type", initialValue: "initial_value",
      notifyOnChange: "notify_on_change", enabled: "enabled",
    };
    for (const [key, col] of Object.entries(map)) {
      if ((updates as Record<string, unknown>)[key] !== undefined) {
        sets.push(`${col} = ?`);
        const val = (updates as Record<string, unknown>)[key];
        values.push(typeof val === "boolean" ? (val ? 1 : 0) : val as string | number);
      }
    }
    if (sets.length === 0) return false;
    values.push(id);
    const result = this.db.run(
      `UPDATE states SET ${sets.join(", ")} WHERE id = ?`,
      values as never,
    );
    return result.changes > 0;
  }

  /**
   * 设置状态值，返回变更信息（无变化返回 null）
   * 内部更新 currentValue + 插入 change record
   */
  setValue(stateId: number, newValue: string, source: string, sourceRuleId: number): StateChange | null {
    const state = this.getState(stateId);
    if (!state) return null;

    /** 值未变化则不记录 */
    if (state.currentValue === newValue) return null;

    this.db.run(`UPDATE states SET current_value = ? WHERE id = ?`, [newValue, stateId]);

    const result = this.db.run(`
      INSERT INTO state_changes (state_id, state_name, camera_id, old_value, new_value, source, source_rule_id, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [stateId, state.name, state.cameraId, state.currentValue, newValue, source, sourceRuleId, Date.now()]);

    return {
      id: Number(result.lastInsertRowid),
      stateId,
      stateName: state.name,
      cameraId: state.cameraId,
      oldValue: state.currentValue,
      newValue,
      source,
      sourceRuleId,
      timestamp: Date.now(),
    };
  }

  /** 删除状态 */
  removeState(id: number): boolean {
    this.db.run(`DELETE FROM state_changes WHERE state_id = ?`, [id]);
    const result = this.db.run(`DELETE FROM states WHERE id = ?`, [id]);
    return result.changes > 0;
  }

  /** 查询状态变更历史 */
  queryChanges(options: {
    stateId?: number;
    cameraId?: string;
    since?: number;
    until?: number;
    limit?: number;
    offset?: number;
  }): StateChange[] {
    const conds: string[] = [];
    const values: (string | number)[] = [];
    if (options.stateId !== undefined) { conds.push("state_id = ?"); values.push(options.stateId); }
    if (options.cameraId) { conds.push("camera_id = ?"); values.push(options.cameraId); }
    if (options.since !== undefined) { conds.push("timestamp >= ?"); values.push(options.since); }
    if (options.until !== undefined) { conds.push("timestamp <= ?"); values.push(options.until); }
    const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    return this.db.query(`
      SELECT id, state_id AS stateId, state_name AS stateName, camera_id AS cameraId,
        old_value AS oldValue, new_value AS newValue, source,
        source_rule_id AS sourceRuleId, timestamp
      FROM state_changes ${where}
      ORDER BY timestamp DESC
      LIMIT ? OFFSET ?
    `).all(...values, limit, offset) as StateChange[];
  }

  /** 查询变更记录数量 */
  countChanges(options: {
    stateId?: number;
    cameraId?: string;
    since?: number;
    until?: number;
  }): number {
    const conds: string[] = [];
    const values: (string | number)[] = [];
    if (options.stateId !== undefined) { conds.push("state_id = ?"); values.push(options.stateId); }
    if (options.cameraId) { conds.push("camera_id = ?"); values.push(options.cameraId); }
    if (options.since !== undefined) { conds.push("timestamp >= ?"); values.push(options.since); }
    if (options.until !== undefined) { conds.push("timestamp <= ?"); values.push(options.until); }
    const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
    const row = this.db.query(`SELECT COUNT(*) AS cnt FROM state_changes ${where}`).get(...values) as { cnt: number };
    return row.cnt;
  }

  /** 清理过期记录 */
  purge(beforeTimestamp: number): number {
    const result = this.db.run(`DELETE FROM state_changes WHERE timestamp < ?`, [beforeTimestamp]);
    return result.changes;
  }

  private defaultForType(valueType: string): string {
    switch (valueType) {
      case "boolean": return "false";
      case "number": return "0";
      default: return "";
    }
  }

  close(): void {
    this.db.close();
  }
}
