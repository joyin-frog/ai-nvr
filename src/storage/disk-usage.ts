import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

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
 * 带缓存，避免每次请求递归扫描文件系统
 */
export class DiskUsage {
  private dataRoot: string;
  /** 缓存的磁盘信息 */
  private cachedInfo: DiskInfo | null = null;
  /** 缓存过期时间 */
  private cacheExpiry = 0;
  /** 缓存 TTL（60 秒） */
  private static readonly CACHE_TTL = 60_000;

  constructor(dataRoot: string) {
    this.dataRoot = dataRoot;
  }

  /** 获取完整磁盘信息（带缓存） */
  getInfo(): DiskInfo {
    const now = Date.now();
    if (this.cachedInfo && now < this.cacheExpiry) return this.cachedInfo;

    const directories: DirUsage[] = [];
    let totalBytes = 0;

    if (existsSync(this.dataRoot)) {
      const entries = readdirSync(this.dataRoot, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(this.dataRoot, entry.name);
        if (entry.isDirectory()) {
          const usage = this.calcDirSize(entry.name, fullPath);
          directories.push(usage);
          totalBytes += usage.bytes;
        } else if (entry.isFile()) {
          try { totalBytes += statSync(fullPath).size; } catch { /* */ }
        }
      }
    }

    const disk = this.getDiskSpace();
    this.cachedInfo = {
      directories,
      totalBytes,
      diskFreeBytes: disk?.free ?? 0,
      diskTotalBytes: disk?.total ?? 0,
    };
    this.cacheExpiry = now + DiskUsage.CACHE_TTL;
    return this.cachedInfo;
  }

  /** 使缓存失效（文件增删后调用） */
  invalidate(): void {
    this.cachedInfo = null;
    this.cacheExpiry = 0;
  }

  /** 计算目录大小 */
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
}
