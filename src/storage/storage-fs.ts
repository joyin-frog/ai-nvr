import { mkdir, unlink, writeFile, copyFile, rename, stat, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { type DiskUsage } from "@/storage/disk-usage";

/**
 * 存储文件系统封装（异步版本）
 * 所有录像/快照/导出文件的增删改操作通过此接口
 * 自动触发 DiskUsage 增量统计更新
 */
export class StorageFs {
  /** 数据根目录 */
  private dataRoot: string;
  /** 磁盘用量追踪器 */
  diskUsage: DiskUsage;

  constructor(dataRoot: string, diskUsage: DiskUsage) {
    this.dataRoot = dataRoot;
    this.diskUsage = diskUsage;
  }

  /**
   * 写入文件并记录增量
   * @param relativePath 相对于 dataRoot 的路径，如 "recordings/cam1/2024-01-01.mp4"
   * @param data 文件内容
   */
  async writeFile(relativePath: string, data: Buffer | Uint8Array | string): Promise<void> {
    const fullPath = this.resolve(relativePath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, data);
    await this.trackAdd(relativePath);
  }

  /**
   * 删除文件并记录增量
   * @param relativePath 相对路径
   */
  async deleteFile(relativePath: string): Promise<boolean> {
    const fullPath = this.resolve(relativePath);
    const size = await this.trackRemove(relativePath);
    if (size === 0) return false;
    await unlink(fullPath);
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
   * 移动/重命名文件，更新增量
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
   * 复制文件，记录增量
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
