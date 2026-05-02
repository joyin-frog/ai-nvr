import { Database, type Statement } from "bun:sqlite";
import { join } from "node:path";
import { readdir, stat } from "node:fs/promises";

/** 文件索引条目 */
export interface FileEntry {
  /** 分类：recordings | snapshots | alert-snapshots | exports | thumbnails | tracks */
  category: string;
  /** 相对路径，如 "cam1/2024-01-01_12-00-00.mp4" */
  relativePath: string;
  /** 摄像头 ID（从路径解析） */
  cameraId?: string;
  /** 文件大小（bytes） */
  size: number;
  /** 修改时间（ms） */
  mtimeMs: number;
  /** JSON 元数据（快照的 detectionLabels 等） */
  extra?: string;
  /** 业务时间（从文件名解析，如录像开始时间） */
  createdAt?: number;
}

/** 文件查询参数 */
export interface FileQuery {
  category: string;
  cameraId?: string;
  /** createdAt 范围过滤 */
  since?: number;
  until?: number;
  limit?: number;
  offset?: number;
}

/**
 * 文件元数据 SQLite 索引
 * 共享 disk-usage.db，在文件写入/删除时增量维护
 * 读取时只查 SQLite，不扫描文件系统
 */
export class FileIndex {
  private db: Database;
  private stmtRegister: Statement;
  private stmtRemove: Statement;
  private stmtRemoveByCategory: Statement;
  private stmtRemoveByCategoryAndCamera: Statement;
  private stmtGet: Statement;
  private stmtLatest: Statement;
  private stmtCount: Statement;
  private stmtRemoveOlder: Statement;
  private stmtLatestNoCam: Statement;
  private stmtListExpired: Statement;
  private stmtHasData: Statement;

  /** 已完成校准的 category 集合 */
  private calibratedCategories = new Set<string>();

  constructor(db: Database) {
    this.db = db;
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.run("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA wal_autocheckpoint = 1000");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS file_index (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        category      TEXT    NOT NULL,
        relative_path TEXT    NOT NULL,
        camera_id     TEXT,
        size          INTEGER NOT NULL DEFAULT 0,
        mtime_ms      REAL    NOT NULL DEFAULT 0,
        extra         TEXT,
        created_at    REAL    NOT NULL DEFAULT 0,
        UNIQUE(category, relative_path)
      )
    `);

    this.db.exec("CREATE INDEX IF NOT EXISTS idx_fi_cat_cam ON file_index(category, camera_id)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_fi_cat_mtime ON file_index(category, mtime_ms)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_fi_cat_created ON file_index(category, created_at)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_fi_cat_cam_created ON file_index(category, camera_id, created_at)");

    /** 预编译语句 */
    this.stmtRegister = this.db.prepare(
      `INSERT INTO file_index (category, relative_path, camera_id, size, mtime_ms, extra, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(category, relative_path) DO UPDATE SET
         camera_id = excluded.camera_id,
         size = excluded.size,
         mtime_ms = excluded.mtime_ms,
         extra = excluded.extra,
         created_at = excluded.created_at`
    );
    this.stmtRemove = this.db.prepare(
      "DELETE FROM file_index WHERE category = ? AND relative_path = ?"
    );
    this.stmtRemoveByCategory = this.db.prepare(
      "DELETE FROM file_index WHERE category = ?"
    );
    this.stmtRemoveByCategoryAndCamera = this.db.prepare(
      "DELETE FROM file_index WHERE category = ? AND camera_id = ?"
    );
    this.stmtGet = this.db.prepare(
      "SELECT * FROM file_index WHERE category = ? AND relative_path = ?"
    );
    this.stmtLatest = this.db.prepare(
      "SELECT * FROM file_index WHERE category = ? AND camera_id = ? ORDER BY created_at DESC LIMIT 1"
    );
    this.stmtCount = this.db.prepare(
      "SELECT COUNT(*) as count, COALESCE(SUM(size), 0) as total_size FROM file_index WHERE category = ? AND (? IS NULL OR camera_id = ?)"
    );
    this.stmtRemoveOlder = this.db.prepare(
      "DELETE FROM file_index WHERE category = ? AND created_at > 0 AND created_at < ?"
    );
    this.stmtLatestNoCam = this.db.prepare(
      "SELECT * FROM file_index WHERE category = ? ORDER BY created_at DESC LIMIT 1"
    );
    this.stmtListExpired = this.db.prepare(
      "SELECT * FROM file_index WHERE category = ? AND created_at > 0 AND created_at < ?"
    );
    this.stmtHasData = this.db.prepare(
      "SELECT COUNT(*) as c FROM file_index WHERE category = ?"
    );
  }

  /** 注册文件（写入/创建后调用） */
  registerFile(entry: FileEntry): void {
    this.stmtRegister.run(
      entry.category,
      entry.relativePath,
      entry.cameraId ?? null,
      entry.size,
      entry.mtimeMs,
      entry.extra ?? null,
      entry.createdAt ?? 0,
    );
  }

  /** 批量注册（事务） */
  registerFiles(entries: FileEntry[]): void {
    const tx = this.db.transaction(() => {
      for (const entry of entries) {
        this.stmtRegister.run(
          entry.category,
          entry.relativePath,
          entry.cameraId ?? null,
          entry.size,
          entry.mtimeMs,
          entry.extra ?? null,
          entry.createdAt ?? 0,
        );
      }
    });
    tx();
  }

  /** 移除文件索引 */
  removeFile(category: string, relativePath: string): void {
    this.stmtRemove.run(category, relativePath);
  }

  /** 移除某个 category 下所有文件索引 */
  removeByCategory(category: string): void {
    this.stmtRemoveByCategory.run(category);
  }

  /** 移除某个 category + cameraId 下所有文件索引 */
  removeByCategoryAndCamera(category: string, cameraId: string): void {
    this.stmtRemoveByCategoryAndCamera.run(category, cameraId);
  }

  /** 移除某个 category 中早于指定时间的文件索引 */
  removeOlder(category: string, cutoffMs: number): void {
    this.stmtRemoveOlder.run(category, cutoffMs);
  }

  /** 列出文件（支持过滤、分页） */
  listFiles(query: FileQuery): FileEntry[] {
    const { category, cameraId, since, until, limit, offset } = query;

    const conditions: string[] = ["category = ?"];
    const params: (string | number | null)[] = [category];

    if (cameraId) {
      conditions.push("camera_id = ?");
      params.push(cameraId);
    }
    if (since != null && since > 0) {
      conditions.push("created_at >= ?");
      params.push(since);
    }
    if (until != null && until > 0) {
      conditions.push("(created_at > 0 AND created_at <= ? OR created_at = 0)");
      params.push(until);
    }

    let sql = `SELECT * FROM file_index WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC`;
    if (limit != null && limit > 0) {
      sql += " LIMIT ?";
      params.push(limit);
      if (offset != null && offset > 0) {
        sql += " OFFSET ?";
        params.push(offset);
      }
    }

    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map(r => this.rowToEntry(r));
  }

  /** 获取单个文件元数据 */
  getFile(category: string, relativePath: string): FileEntry | null {
    const row = this.stmtGet.get(category, relativePath) as Record<string, unknown> | null;
    return row ? this.rowToEntry(row) : null;
  }

  /** 获取某个 category + cameraId 下最新的文件 */
  getLatestFile(category: string, cameraId?: string): FileEntry | null {
    if (cameraId) {
      const row = this.stmtLatest.get(category, cameraId) as Record<string, unknown> | null;
      return row ? this.rowToEntry(row) : null;
    }
    const rows = this.stmtLatestNoCam.all(category) as Array<Record<string, unknown>>;
    return rows[0] ? this.rowToEntry(rows[0]) : null;
  }

  /** 统计文件数量和总大小 */
  countFiles(category: string, cameraId?: string): { count: number; totalSize: number } {
    const row = this.stmtCount.get(category, cameraId ?? null, cameraId ?? null) as { count: number; total_size: number };
    return { count: row.count, totalSize: row.total_size };
  }

  /** 查询过期文件（用于 purge，返回 createdAt < cutoff 的条目） */
  listExpired(category: string, cutoffMs: number): FileEntry[] {
    const rows = this.stmtListExpired.all(category, cutoffMs) as Array<Record<string, unknown>>;
    return rows.map(r => this.rowToEntry(r));
  }

  /** 检查某 category 是否已有索引数据 */
  hasData(category: string): boolean {
    const row = this.stmtHasData.get(category) as { c: number };
    return row.c > 0;
  }

  /**
   * 从文件系统全量扫描填充索引（首次启动或手动触发）
   * 异步执行，不阻塞事件循环
   */
  async calibrate(category: string, baseDir: string, parser?: (relativePath: string) => { cameraId?: string; createdAt?: number; extra?: string }): Promise<number> {
    if (this.calibratedCategories.has(category)) return 0;

    let registered = 0;
    const scan = async (dir: string, prefix: string) => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      const batch: FileEntry[] = [];
      for (const entry of entries) {
        const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          await scan(fullPath, relPath);
        } else if (entry.isFile()) {
          try {
            const s = await stat(fullPath);
            let cameraId: string | undefined;
            let createdAt: number | undefined;
            let extra: string | undefined;
            if (parser) {
              const parsed = parser(relPath);
              cameraId = parsed.cameraId;
              createdAt = parsed.createdAt;
              extra = parsed.extra;
            } else {
              /** 默认从路径提取 cameraId（第一级子目录） */
              const parts = relPath.split("/");
              if (parts.length >= 2) cameraId = parts[0];
            }
            batch.push({
              category,
              relativePath: relPath,
              cameraId,
              size: s.size,
              mtimeMs: s.mtimeMs,
              createdAt: createdAt ?? Math.floor(s.mtimeMs),
              extra,
            });
            if (batch.length >= 500) {
              this.registerFiles(batch);
              registered += batch.length;
              batch.length = 0;
            }
          } catch {
            /* 文件可能正在写入 */
          }
        }
      }
      if (batch.length > 0) {
        this.registerFiles(batch);
        registered += batch.length;
      }
    };

    await scan(baseDir, "");
    this.calibratedCategories.add(category);
    return registered;
  }

  /** 将数据库行转为 FileEntry */
  private rowToEntry(row: Record<string, unknown>): FileEntry {
    return {
      category: row.category as string,
      relativePath: row.relative_path as string,
      cameraId: (row.camera_id as string) || undefined,
      size: row.size as number,
      mtimeMs: row.mtime_ms as number,
      extra: (row.extra as string) || undefined,
      createdAt: (row.created_at as number) || undefined,
    };
  }
}
