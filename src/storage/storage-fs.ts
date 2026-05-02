import { mkdir, unlink, writeFile, copyFile, rename, stat, readFile, readdir, open } from "node:fs/promises";
import { join, dirname } from "node:path";
import { type DiskUsage } from "@/storage/disk-usage";
import { FileIndex } from "@/storage/file-index";
import type { Dirent, Stats } from "node:fs";

/**
 * 存储文件系统封装（异步版本）
 * 所有录像/快照/导出文件的增删改操作通过此接口
 * 自动触发 DiskUsage 增量统计 + FileIndex 索引维护
 */
export class StorageFs {
  /** 数据根目录 */
  private dataRoot: string;
  /** 磁盘用量追踪器 */
  diskUsage: DiskUsage;
  /** 文件元数据索引 */
  fileIndex: FileIndex;

  constructor(dataRoot: string, diskUsage: DiskUsage) {
    this.dataRoot = dataRoot;
    this.diskUsage = diskUsage;
    this.fileIndex = new FileIndex(diskUsage.db);
  }

  /**
   * 写入文件并记录增量 + 注册索引
   * @param relativePath 相对于 dataRoot 的路径，如 "recordings/cam1/2024-01-01.mp4"
   * @param data 文件内容
   * @param indexMeta 可选的索引元数据（category、cameraId 等）
   */
  async writeFile(relativePath: string, data: Buffer | Uint8Array | string, indexMeta?: { category: string; cameraId?: string; createdAt?: number; extra?: string }): Promise<void> {
    const fullPath = this.resolve(relativePath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, data);
    await this.trackAdd(relativePath);

    if (indexMeta) {
      const s = await stat(fullPath);
      this.fileIndex.registerFile({
        category: indexMeta.category,
        relativePath: relativePath.startsWith(indexMeta.category + "/")
          ? relativePath.slice(indexMeta.category.length + 1)
          : relativePath,
        cameraId: indexMeta.cameraId,
        size: s.size,
        mtimeMs: s.mtimeMs,
        createdAt: indexMeta.createdAt,
        extra: indexMeta.extra,
      });
    }
  }

  /**
   * 删除文件并记录增量 + 移除索引
   * @param relativePath 相对路径
   * @param indexMeta 可选的索引元数据，用于同步移除索引
   */
  async deleteFile(relativePath: string, indexMeta?: { category: string }): Promise<boolean> {
    const fullPath = this.resolve(relativePath);
    const size = await this.trackRemove(relativePath);
    if (size === 0) return false;
    await unlink(fullPath);

    if (indexMeta) {
      const indexPath = relativePath.startsWith(indexMeta.category + "/")
        ? relativePath.slice(indexMeta.category.length + 1)
        : relativePath;
      this.fileIndex.removeFile(indexMeta.category, indexPath);
    }
    return true;
  }

  /**
   * 确保目录存在
   * @param relativePath 相对路径（可以是文件路径，自动取 dirname）
   */
  async ensureDir(relativePath: string): Promise<void> {
    const fullPath = this.resolve(relativePath);
    await mkdir(dirname(fullPath), { recursive: true });
  }

  /**
   * 移动/重命名文件，更新增量 + 索引
   */
  async renameFile(oldPath: string, newPath: string): Promise<void> {
    const oldFull = this.resolve(oldPath);
    const newFull = this.resolve(newPath);
    await this.ensureDir(newPath);
    const s = await stat(oldFull);
    await rename(oldFull, newFull);
    this.diskUsage.recordRemove(this.getDirName(oldPath), s.size);
    this.diskUsage.recordAdd(this.getDirName(newPath), s.size);
  }

  /**
   * 复制文件，记录增量 + 索引
   */
  async copyFile(srcPath: string, destPath: string): Promise<void> {
    const srcFull = this.resolve(srcPath);
    const destFull = this.resolve(destPath);
    await this.ensureDir(destPath);
    await copyFile(srcFull, destFull);
    await this.trackAdd(destPath);
  }

  /**
   * 获取文件 stat（异步）
   */
  async stat(relativePath: string): Promise<{ size: number; mtimeMs: number } | null> {
    const fullPath = this.resolve(relativePath);
    try {
      const s = await stat(fullPath);
      return { size: s.size, mtimeMs: s.mtimeMs };
    } catch {
      return null;
    }
  }

  /**
   * 检查文件是否存在（异步）
   */
  async exists(relativePath: string): Promise<boolean> {
    try {
      await stat(this.resolve(relativePath));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 读取文件内容（异步）
   */
  async readFile(relativePath: string): Promise<Buffer> {
    return readFile(this.resolve(relativePath));
  }

  /**
   * 读取文件指定范围（异步，用于 MP4 时长解析）
   */
  async readFilePart(relativePath: string, length: number, offset: number = 0): Promise<Buffer> {
    const fullPath = this.resolve(relativePath);
    const fd = await open(fullPath, "r");
    const buf = Buffer.alloc(length);
    await fd.read(buf, 0, length, offset);
    await fd.close();
    return buf;
  }

  /**
   * 列出目录内容（异步）
   */
  async readdir(relativePath: string): Promise<string[]> {
    return readdir(this.resolve(relativePath));
  }

  /**
   * 列出目录内容（带类型信息，异步）
   */
  async readdirWithTypes(relativePath: string): Promise<Dirent[]> {
    const fullPath = this.resolve(relativePath);
    const entries = await readdir(fullPath, { withFileTypes: true });
    return entries;
  }

  /**
   * 删除文件（异步，无磁盘统计、无索引）
   */
  async unlink(relativePath: string): Promise<void> {
    await unlink(this.resolve(relativePath));
  }

  /**
   * 获取文件 stat（原始 Stats 对象，异步）
   */
  async statRaw(relativePath: string): Promise<Stats | null> {
    try {
      return await stat(this.resolve(relativePath));
    } catch {
      return null;
    }
  }

  /**
   * 获取绝对路径
   */
  resolve(relativePath: string): string {
    return join(this.dataRoot, relativePath);
  }

  /**
   * 获取数据根目录
   */
  get root(): string {
    return this.dataRoot;
  }

  /**
   * 外部进程（如 ffmpeg）写入完成后注册文件索引
   * 用于录像文件、导出文件等不由 StorageFs.writeFile 写入的场景
   */
  async registerExternalFile(category: string, relativePath: string, meta?: { cameraId?: string; createdAt?: number; extra?: string }): Promise<void> {
    const indexPath = relativePath.startsWith(category + "/")
      ? relativePath.slice(category.length + 1)
      : relativePath;
    const fullPath = this.resolve(join(category, indexPath));
    try {
      const s = await stat(fullPath);
      this.fileIndex.registerFile({
        category,
        relativePath: indexPath,
        cameraId: meta?.cameraId,
        size: s.size,
        mtimeMs: s.mtimeMs,
        createdAt: meta?.createdAt,
        extra: meta?.extra,
      });
    } catch {
      /* 文件可能不存在 */
    }
  }

  /**
   * 批量删除某个 category 下的过期文件
   * @returns 删除的文件数量
   */
  async deleteExpiredFiles(category: string, cutoffMs: number): Promise<number> {
    const expired = this.fileIndex.listExpired(category, cutoffMs);
    let deleted = 0;
    for (const entry of expired) {
      const fullPath = this.resolve(join(category, entry.relativePath));
      try {
        const s = await stat(fullPath);
        await unlink(fullPath);
        this.diskUsage.recordRemove(category, s.size);
        deleted++;
      } catch {
        /* 文件可能已不存在 */
      }
    }
    this.fileIndex.removeOlder(category, cutoffMs);
    return deleted;
  }

  /**
   * 删除某个 category 下所有文件并清理索引
   * @returns 删除的文件数量
   */
  async deleteAllFiles(category: string): Promise<number> {
    const all = this.fileIndex.listFiles({ category, limit: 100000 });
    let deleted = 0;
    for (const entry of all) {
      const fullPath = this.resolve(join(category, entry.relativePath));
      try {
        await unlink(fullPath);
        deleted++;
      } catch {
        /* 文件可能已不存在 */
      }
    }
    this.fileIndex.removeByCategory(category);
    return deleted;
  }

  /** 记录文件新增 */
  private async trackAdd(relativePath: string): Promise<void> {
    const fullPath = this.resolve(relativePath);
    const s = await stat(fullPath);
    const dirName = this.getDirName(relativePath);
    this.diskUsage.recordAdd(dirName, s.size);
  }

  /** 记录文件删除，返回文件大小 */
  private async trackRemove(relativePath: string): Promise<number> {
    const fullPath = this.resolve(relativePath);
    try {
      const s = await stat(fullPath);
      const dirName = this.getDirName(relativePath);
      this.diskUsage.recordRemove(dirName, s.size);
      return s.size;
    } catch {
      return 0;
    }
  }

  /** 从相对路径提取一级子目录名 */
  private getDirName(relativePath: string): string {
    /** "recordings/cam1/file.mp4" → "recordings" */
    return relativePath.split("/")[0] ?? "unknown";
  }
}
