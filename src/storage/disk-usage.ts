import { existsSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

/** 目录磁盘用量 */
export interface DirUsage {
  /** 目录名称 */
  name: string;
  /** 总字节数 */
  bytes: number;
  /** 文件数量 */
  fileCount: number;
}

/** 磁盘信息 */
export interface DiskInfo {
  /** 各子目录用量 */
  directories: DirUsage[];
  /** 数据总用量（字节） */
  totalBytes: number;
  /** 磁盘可用空间（字节） */
  diskFreeBytes: number;
  /** 磁盘总空间（字节） */
  diskTotalBytes: number;
}

/**
 * 存储磁盘用量统计
 * SQLite 持久化 + 增量追踪，重启后不丢失
 * 文件增删时实时更新，永不全量扫描（除非手动触发）
 */
export class DiskUsage {
  private dataRoot: string;
  private db: Database;
  /** 内存缓存（避免每次查 SQLite） */
  private cache: Map<string, { bytes: number; fileCount: number }> = new Map();
  /** 缓存是否已加载 */
  private loaded = false;
  /** 磁盘空间缓存（60 秒刷新） */
  private diskSpaceCache: { total: number; free: number } | null = null;
  private diskSpaceExpiry = 0;

  constructor(dataRoot: string) {
    this.dataRoot = dataRoot;
    this.db = new Database(join(dataRoot, "disk-usage.db"), { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dir_usage (
        name TEXT PRIMARY KEY,
        bytes INTEGER NOT NULL DEFAULT 0,
        file_count INTEGER NOT NULL DEFAULT 0
      )
    `);
  }

  /** 从 SQLite 加载到内存缓存 */
  private ensureLoaded(): void {
    if (this.loaded) return;
    const rows = this.db.query("SELECT * FROM dir_usage").all() as Array<{ name: string; bytes: number; file_count: number }>;
    for (const row of rows) {
      this.cache.set(row.name, { bytes: row.bytes, fileCount: row.file_count });
    }
    this.loaded = true;
  }

  /** 获取完整磁盘信息（纯缓存读取，零 I/O） */
  getInfo(): DiskInfo {
    this.ensureLoaded();

    const directories: DirUsage[] = [];
    let totalBytes = 0;
    for (const [name, data] of this.cache) {
      directories.push({ name, bytes: data.bytes, fileCount: data.fileCount });
      totalBytes += data.bytes;
    }

    const disk = this.getDiskSpaceCached();
    return {
      directories,
      totalBytes,
      diskFreeBytes: disk?.free ?? 0,
      diskTotalBytes: disk?.total ?? 0,
    };
  }

  /** 记录文件新增 */
  recordAdd(dirName: string, fileSize: number): void {
    this.ensureLoaded();
    const existing = this.cache.get(dirName);
    if (existing) {
      existing.bytes += fileSize;
      existing.fileCount += 1;
    } else {
      this.cache.set(dirName, { bytes: fileSize, fileCount: 1 });
    }
    this.persist(dirName);
  }

  /** 记录文件删除 */
  recordRemove(dirName: string, fileSize: number): void {
    this.ensureLoaded();
    const existing = this.cache.get(dirName);
    if (existing) {
      existing.bytes = Math.max(0, existing.bytes - fileSize);
      existing.fileCount = Math.max(0, existing.fileCount - 1);
    }
    this.persist(dirName);
  }

  /** 手动触发全量校准 */
  calibrate(): void {
    this.cache.clear();

    if (!existsSync(this.dataRoot)) {
      this.loaded = true;
      return;
    }

    const entries = readdirSync(this.dataRoot, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(this.dataRoot, entry.name);
      if (entry.isDirectory()) {
        const usage = this.calcDirSize(entry.name, fullPath);
        this.cache.set(usage.name, { bytes: usage.bytes, fileCount: usage.fileCount });
      }
    }
    this.loaded = true;

    /** 全量写入 SQLite */
    this.db.exec("DELETE FROM dir_usage");
    const stmt = this.db.prepare("INSERT INTO dir_usage (name, bytes, file_count) VALUES (?, ?, ?)");
    const tx = this.db.transaction(() => {
      for (const [name, data] of this.cache) {
        stmt.run(name, data.bytes, data.fileCount);
      }
    });
    tx();
  }

  /** 持久化单目录到 SQLite */
  private persist(dirName: string): void {
    const data = this.cache.get(dirName);
    if (!data) return;
    this.db.prepare(
      "INSERT INTO dir_usage (name, bytes, file_count) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET bytes = excluded.bytes, file_count = excluded.file_count"
    ).run(dirName, data.bytes, data.fileCount);
  }

  /** 磁盘空间缓存（60 秒刷新） */
  private getDiskSpaceCached(): { total: number; free: number } | null {
    const now = Date.now();
    if (this.diskSpaceCache && now < this.diskSpaceExpiry) return this.diskSpaceCache;
    this.diskSpaceCache = this.getDiskSpace();
    this.diskSpaceExpiry = now + 60_000;
    return this.diskSpaceCache;
  }

  /** 计算目录大小（仅校准使用） */
  private calcDirSize(name: string, dirPath: string): DirUsage {
    let bytes = 0;
    let fileCount = 0;

    const scan = (path: string) => {
      try {
        const entries = readdirSync(path, { withFileTypes: true });
        for (const entry of entries) {
          const full = join(path, entry.name);
          if (entry.isDirectory()) {
            scan(full);
          } else if (entry.isFile()) {
            try { bytes += statSync(full).size; fileCount++; } catch { /* */ }
          }
        }
      } catch { /* */ }
    };

    scan(dirPath);
    return { name, bytes, fileCount };
  }

  /** 获取磁盘空间 */
  private getDiskSpace(): { total: number; free: number } | null {
    try {
      const proc = Bun.spawnSync(["df", "-B1", this.dataRoot], {
        stdout: "pipe",
        stderr: "ignore",
      });
      const output = new TextDecoder().decode(proc.stdout);
      const lines = output.trim().split("\n");
      if (lines.length >= 2) {
        const parts = lines[1]!.trim().split(/\s+/);
        if (parts.length >= 4) {
          return {
            total: Number(parts[1]),
            free: Number(parts[3]),
          };
        }
      }
    } catch { /* */ }
    return null;
  }

  /** 确保 SQLite 有基准数据（首次启动时全量扫描） */
  ensureCalibrated(): void {
    const count = (this.db.query("SELECT COUNT(*) as c FROM dir_usage").get() as { c: number }).c;
    if (count === 0) {
      console.log("[DiskUsage] 首次启动，全量校准...");
      this.calibrate();
    }
  }

  /** 关闭数据库 */
  close(): void {
    this.db.close();
  }
}
