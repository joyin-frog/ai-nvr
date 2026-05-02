import { readdir, stat } from "node:fs/promises";
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
 * 文件增删时通过 StorageFs 实时更新，永不全量扫描
 */
export class DiskUsage {
  private dataRoot: string;
  /** 暴露给 FileIndex 共享连接 */
  readonly db: Database;
  /** 内存缓存（避免每次查 SQLite） */
  private cache: Map<string, { bytes: number; fileCount: number }> = new Map();
  /** 缓存是否已加载 */
  private loaded = false;
  /** 磁盘空间缓存（后台定时刷新，API 只读缓存） */
  private diskSpaceCache: { total: number; free: number } | null = null;
  /** 后台刷新定时器 */
  private diskSpaceTimer: ReturnType<typeof setInterval> | null = null;

  constructor(dataRoot: string) {
    this.dataRoot = dataRoot;
    this.db = new Database(join(dataRoot, "disk-usage.db"), { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA wal_autocheckpoint = 1000");
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

    return {
      directories,
      totalBytes,
      diskFreeBytes: this.diskSpaceCache?.free ?? 0,
      diskTotalBytes: this.diskSpaceCache?.total ?? 0,
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

  /**
   * 启动后台磁盘空间刷新（每 60 秒异步查询一次）
   * API 请求只读缓存，永不阻塞
   */
  startBackgroundRefresh(): void {
    /** 首次延迟 10 秒执行，避免启动 IO 压力 */
    setTimeout(() => this.refreshDiskSpace(), 10_000);
    this.diskSpaceTimer = setInterval(() => this.refreshDiskSpace(), 60_000);
  }

  /** 后台异步刷新磁盘空间缓存 */
  private async refreshDiskSpace(): Promise<void> {
    try {
      const proc = Bun.spawn(["df", "-B1", this.dataRoot], {
        stdout: "pipe",
        stderr: "ignore",
      });
      const exitCode = await proc.exited;
      if (exitCode !== 0) return;
      const output = await new Response(proc.stdout).text();
      const lines = output.trim().split("\n");
      if (lines.length >= 2) {
        const parts = lines[1]!.trim().split(/\s+/);
        if (parts.length >= 4) {
          this.diskSpaceCache = {
            total: Number(parts[1]),
            free: Number(parts[3]),
          };
        }
      }
    } catch {
      /* df 命令失败，保持旧缓存 */
    }
  }

  /** 持久化单目录到 SQLite */
  private persist(dirName: string): void {
    const data = this.cache.get(dirName);
    if (!data) return;
    this.db.prepare(
      "INSERT INTO dir_usage (name, bytes, file_count) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET bytes = excluded.bytes, file_count = excluded.file_count"
    ).run(dirName, data.bytes, data.fileCount);
  }

  /**
   * 手动全量校准（仅用户主动触发）
   * 异步扫描文件系统，重建 SQLite 中的用量数据
   */
  async calibrateAsync(): Promise<void> {
    this.cache.clear();

    let entries;
    try {
      entries = await readdir(this.dataRoot, { withFileTypes: true });
    } catch {
      this.loaded = true;
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const fullPath = join(this.dataRoot, entry.name);
        const usage = await this.calcDirSizeAsync(entry.name, fullPath);
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

  /** 异步计算目录大小 */
  private async calcDirSizeAsync(name: string, dirPath: string): Promise<DirUsage> {
    let bytes = 0;
    let fileCount = 0;

    const scan = async (path: string) => {
      let entries;
      try {
        entries = await readdir(path, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(path, entry.name);
        if (entry.isDirectory()) {
          await scan(full);
        } else if (entry.isFile()) {
          try {
            const s = await stat(full);
            bytes += s.size;
            fileCount++;
          } catch {
            /* 文件可能正在写入 */
          }
        }
      }
    };

    await scan(dirPath);
    return { name, bytes, fileCount };
  }

  /** 关闭数据库 + 停止后台刷新 */
  close(): void {
    if (this.diskSpaceTimer) {
      clearInterval(this.diskSpaceTimer);
      this.diskSpaceTimer = null;
    }
    this.db.close();
  }
}
