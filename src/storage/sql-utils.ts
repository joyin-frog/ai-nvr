import { Database, type Database as DatabaseType } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * 创建并初始化 SQLite 数据库（WAL 模式 + 标准优化 PRAGMA）
 * 所有 Storage 类共用，确保配置一致
 */
export function createDb(dbPath: string): DatabaseType {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true });
  initDbPragmas(db);
  return db;
}

/** 初始化标准 PRAGMA（用于接收外部 Database 实例的场景） */
export function initDbPragmas(db: DatabaseType): void {
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA busy_timeout = 5000");
  db.run("PRAGMA wal_autocheckpoint = 1000");
}

/**
 * 分批删除旧记录，避免长事务锁（所有 Storage 共用）
 * 每批删除 BATCH 条，循环直到 changes < BATCH 为止
 */
export function batchPurge(
  db: Database,
  tableName: string,
  timestampColumn: string,
  beforeTimestamp: number,
): number {
  let total = 0;
  const BATCH = 5000;
  for (;;) {
    const result = db.run(
      `DELETE FROM ${tableName} WHERE id IN (SELECT id FROM ${tableName} WHERE ${timestampColumn} < ? LIMIT ?)`,
      [beforeTimestamp, BATCH],
    );
    total += result.changes;
    if (result.changes < BATCH) break;
  }
  return total;
}
