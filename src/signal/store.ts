import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** 信号定义（原 StateDef） */
export interface Signal {
  id: number;
  /** 信号名称（如"门禁已关闭"） */
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

/** 信号变更记录 */
export interface SignalChange {
  id: number;
  /** 信号 ID */
  signalId: number;
  /** 信号名称快照 */
  signalName: string;
  /** 摄像头 ID */
  cameraId: string;
  /** 旧值 */
  oldValue: string;
  /** 新值 */
  newValue: string;
  /** 来源（manual / observer:观测器ID / system） */
  source: string;
  /** 来源对象 ID（0=手动） */
  sourceId: number;
  /** 变更时间戳 */
  timestamp: number;
}

/**
 * 信号存储（原 StateStorage）
 * 纯粹的命名值容器，值的来源由外部决定
 */
export class SignalStore {
  private db: Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = NORMAL");
    this.db.run("PRAGMA busy_timeout = 5000");
    this.db.run("PRAGMA wal_autocheckpoint = 1000");

    this.db.run(`
      CREATE TABLE IF NOT EXISTS signals (
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
      CREATE TABLE IF NOT EXISTS signal_changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        signal_id INTEGER NOT NULL,
        signal_name TEXT NOT NULL,
        camera_id TEXT NOT NULL DEFAULT '',
        old_value TEXT NOT NULL DEFAULT '',
        new_value TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'manual',
        source_id INTEGER NOT NULL DEFAULT 0,
        timestamp INTEGER NOT NULL,
        FOREIGN KEY (signal_id) REFERENCES signals(id)
      )
    `);

    this.db.run("CREATE INDEX IF NOT EXISTS idx_signal_changes_timestamp ON signal_changes(timestamp)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_signal_changes_signal_time ON signal_changes(signal_id, timestamp)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_signal_changes_camera_time ON signal_changes(camera_id, timestamp)");

    /** 兼容迁移：如果旧表 states 存在，自动迁移数据 */
    this.migrateFromLegacy();
  }

  /** 从旧 state 表迁移数据 */
  private migrateFromLegacy(): void {
    const tables = this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='states'").all();
    if (tables.length === 0) {
      /** 检查 signals 表是否为空，如果空且 states 表存在则复制 */
      return;
    }

    /** 检查 signals 表是否有数据 */
    const signalCount = (this.db.query("SELECT COUNT(*) as cnt FROM signals").get() as { cnt: number }).cnt;
    if (signalCount > 0) return;

    /** 从 states 表复制数据 */
    const legacyStates = this.db.query("SELECT * FROM states").all() as Array<Record<string, unknown>>;
    for (const row of legacyStates) {
      this.db.run(
        `INSERT OR IGNORE INTO signals (id, name, description, camera_id, value_type, initial_value, current_value, notify_on_change, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id, row.name ?? "", row.description ?? "",
          row.camera_id ?? row.cameraId ?? "",
          row.value_type ?? row.valueType ?? "boolean",
          row.initial_value ?? row.initialValue ?? "",
          row.current_value ?? row.currentValue ?? "",
          Number(row.notify_on_change ?? row.notifyOnChange ?? 0),
          Number(row.enabled ?? 1),
        ] as never,
      );
    }

    /** 复制变更记录 */
    const legacyChanges = this.db.query("SELECT * FROM state_changes").all() as Array<Record<string, unknown>>;
    for (const row of legacyChanges) {
      this.db.run(
        `INSERT OR IGNORE INTO signal_changes (id, signal_id, signal_name, camera_id, old_value, new_value, source, source_id, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id, row.state_id ?? row.signalId ?? 0,
          row.state_name ?? row.signalName ?? "",
          row.camera_id ?? row.cameraId ?? "",
          row.old_value ?? row.oldValue ?? "",
          row.new_value ?? row.newValue ?? "",
          row.source ?? "manual",
          Number(row.source_rule_id ?? row.sourceId ?? 0),
          Number(row.timestamp ?? 0),
        ] as never,
      );
    }

    console.log(`[SignalStore] 从旧表迁移了 ${legacyStates.length} 个信号, ${legacyChanges.length} 条变更记录`);
  }

  /** 列出所有信号 */
  listSignals(): Signal[] {
    return this.db.query(`
      SELECT id, name, description, camera_id AS cameraId, value_type AS valueType,
        initial_value AS initialValue, current_value AS currentValue,
        notify_on_change AS notifyOnChange, enabled
      FROM signals ORDER BY id
    `).all() as Signal[];
  }

  /** 获取单个信号 */
  getSignal(id: number): Signal | undefined {
    return this.db.query(`
      SELECT id, name, description, camera_id AS cameraId, value_type AS valueType,
        initial_value AS initialValue, current_value AS currentValue,
        notify_on_change AS notifyOnChange, enabled
      FROM signals WHERE id = ?
    `).get(id) as Signal | undefined;
  }

  /** 添加信号 */
  addSignal(signal: Omit<Signal, "id" | "currentValue">): number {
    const initialValue = signal.initialValue ?? this.defaultForType(signal.valueType);
    const result = this.db.run(`
      INSERT INTO signals (name, description, camera_id, value_type, initial_value, current_value, notify_on_change, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      signal.name, signal.description, signal.cameraId, signal.valueType,
      initialValue, initialValue,
      signal.notifyOnChange ? 1 : 0,
      signal.enabled ? 1 : 0,
    ]);
    return Number(result.lastInsertRowid);
  }

  /** 更新信号定义 */
  updateSignal(id: number, updates: Partial<Pick<Signal, "name" | "description" | "cameraId" | "valueType" | "initialValue" | "notifyOnChange" | "enabled">>): boolean {
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
      `UPDATE signals SET ${sets.join(", ")} WHERE id = ?`,
      values as never,
    );
    return result.changes > 0;
  }

  /**
   * 设置信号值，返回变更信息（无变化返回 null）
   */
  setValue(signalId: number, newValue: string, source: string, sourceId: number): SignalChange | null {
    const signal = this.getSignal(signalId);
    if (!signal) return null;

    if (signal.currentValue === newValue) return null;

    const ts = Date.now();
    const oldValue = signal.currentValue;
    this.db.run("BEGIN");
    let result: ReturnType<typeof this.db.run>;
    try {
      /** 乐观锁：仅当 current_value 仍为预期旧值时才更新 */
      const updateResult = this.db.run(
        `UPDATE signals SET current_value = ? WHERE id = ? AND current_value = ?`,
        [newValue, signalId, oldValue],
      );
      if (updateResult.changes === 0) {
        /** 值已被并发修改，放弃本次更新 */
        this.db.run("ROLLBACK");
        return null;
      }
      result = this.db.run(`
        INSERT INTO signal_changes (signal_id, signal_name, camera_id, old_value, new_value, source, source_id, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [signalId, signal.name, signal.cameraId, oldValue, newValue, source, sourceId, ts]);
      this.db.run("COMMIT");
    } catch (err) {
      this.db.run("ROLLBACK");
      throw err;
    }

    return {
      id: Number(result.lastInsertRowid),
      signalId,
      signalName: signal.name,
      cameraId: signal.cameraId,
      oldValue,
      newValue,
      source,
      sourceId,
      timestamp: ts,
    };
  }

  /** 删除信号 */
  removeSignal(id: number): boolean {
    this.db.run(`DELETE FROM signal_changes WHERE signal_id = ?`, [id]);
    const result = this.db.run(`DELETE FROM signals WHERE id = ?`, [id]);
    return result.changes > 0;
  }

  /** 查询信号变更历史 */
  queryChanges(options: {
    signalId?: number;
    cameraId?: string;
    since?: number;
    until?: number;
    limit?: number;
    offset?: number;
  }): SignalChange[] {
    const conds: string[] = [];
    const values: (string | number)[] = [];
    if (options.signalId !== undefined) { conds.push("signal_id = ?"); values.push(options.signalId); }
    if (options.cameraId) { conds.push("camera_id = ?"); values.push(options.cameraId); }
    if (options.since !== undefined) { conds.push("timestamp >= ?"); values.push(options.since); }
    if (options.until !== undefined) { conds.push("timestamp <= ?"); values.push(options.until); }
    const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    return this.db.query(`
      SELECT id, signal_id AS signalId, signal_name AS signalName, camera_id AS cameraId,
        old_value AS oldValue, new_value AS newValue, source,
        source_id AS sourceId, timestamp
      FROM signal_changes ${where}
      ORDER BY timestamp DESC
      LIMIT ? OFFSET ?
    `).all(...values, limit, offset) as SignalChange[];
  }

  /** 查询变更记录数量 */
  countChanges(options: {
    signalId?: number;
    cameraId?: string;
    since?: number;
    until?: number;
  }): number {
    const conds: string[] = [];
    const values: (string | number)[] = [];
    if (options.signalId !== undefined) { conds.push("signal_id = ?"); values.push(options.signalId); }
    if (options.cameraId) { conds.push("camera_id = ?"); values.push(options.cameraId); }
    if (options.since !== undefined) { conds.push("timestamp >= ?"); values.push(options.since); }
    if (options.until !== undefined) { conds.push("timestamp <= ?"); values.push(options.until); }
    const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
    const row = this.db.query(`SELECT COUNT(*) AS cnt FROM signal_changes ${where}`).get(...values) as { cnt: number };
    return row.cnt;
  }

  /** 清理过期记录 */
  purge(beforeTimestamp: number): number {
    const result = this.db.run(`DELETE FROM signal_changes WHERE timestamp < ?`, [beforeTimestamp]);
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
