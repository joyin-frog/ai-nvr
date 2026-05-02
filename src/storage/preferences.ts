import { Database } from "bun:sqlite";

/** 偏好键值记录 */
export interface PreferenceEntry {
  /** 键名 */
  key: string;
  /** 值（JSON 序列化存储） */
  value: string;
  /** 最后更新时间（ms） */
  updatedAt: number;
}

/**
 * 用户偏好设置存储
 * key-value 模式，value JSON 序列化，支持 string/number/boolean/object/array
 */
export class PreferencesStorage {
  private db: Database;
  private setStmt: import("bun:sqlite").Statement;
  private getStmt: import("bun:sqlite").Statement;
  private deleteStmt: import("bun:sqlite").Statement;
  private getAllStmt: import("bun:sqlite").Statement;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA wal_autocheckpoint = 1000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS preferences (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    this.setStmt = this.db.prepare(
      "INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    );
    this.getStmt = this.db.prepare("SELECT * FROM preferences WHERE key = ?");
    this.deleteStmt = this.db.prepare("DELETE FROM preferences WHERE key = ?");
    this.getAllStmt = this.db.prepare("SELECT * FROM preferences ORDER BY key");
  }

  /** 获取单个偏好值 */
  get(key: string): PreferenceEntry | null {
    const row = this.getStmt.get(key) as Record<string, unknown> | null;
    return row ? this.mapRow(row) : null;
  }

  /** 设置单个偏好值 */
  set(key: string, value: unknown): PreferenceEntry {
    const now = Date.now();
    const json = JSON.stringify(value);
    const row = this.setStmt.get(key, json, now) as Record<string, unknown>;
    return this.mapRow(row);
  }

  /** 批量设置偏好（事务保证原子性） */
  setMany(entries: Record<string, unknown>): void {
    const now = Date.now();
    const tx = this.db.transaction(() => {
      for (const [key, value] of Object.entries(entries)) {
        this.setStmt.run(key, JSON.stringify(value), now);
      }
    });
    tx();
  }

  /** 获取全部偏好 */
  getAll(): PreferenceEntry[] {
    return (this.getAllStmt.all() as Record<string, unknown>[]).map(r => this.mapRow(r));
  }

  /** 删除偏好 */
  delete(key: string): boolean {
    const result = this.deleteStmt.run(key);
    return result.changes > 0;
  }

  /** 获取全部偏好并解析为 Record */
  getAllAsRecord(): Record<string, unknown> {
    const entries = this.getAll();
    const result: Record<string, unknown> = {};
    for (const entry of entries) {
      try {
        result[entry.key] = JSON.parse(entry.value);
      } catch {
        result[entry.key] = entry.value;
      }
    }
    return result;
  }

  /** 关闭数据库 */
  close(): void {
    this.db.close();
  }

  private mapRow(row: Record<string, unknown>): PreferenceEntry {
    return {
      key: row.key as string,
      value: row.value as string,
      updatedAt: row.updated_at as number,
    };
  }
}
