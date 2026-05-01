import { mkdirSync, unlinkSync, writeFileSync, copyFileSync, renameSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { type DiskUsage } from "@/storage/disk-usage";

/**
 * 存储文件系统封装
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
  writeFile(relativePath: string, data: Buffer | Uint8Array | string): void {
    const fullPath = this.resolve(relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, data);
    this.trackAdd(relativePath);
  }

  /**
   * 删除文件并记录增量
   * @param relativePath 相对路径
   */
  deleteFile(relativePath: string): boolean {
    const fullPath = this.resolve(relativePath);
    if (!existsSync(fullPath)) return false;
    this.trackRemove(relativePath);
    unlinkSync(fullPath);
    return true;
  }

  /**
   * 确保目录存在
   * @param relativePath 相对路径（可以是文件路径，自动取 dirname）
   */
  ensureDir(relativePath: string): void {
    const fullPath = this.resolve(relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
  }

  /**
   * 移动/重命名文件，更新增量
   */
  renameFile(oldPath: string, newPath: string): void {
    const oldFull = this.resolve(oldPath);
    const newFull = this.resolve(newPath);
    this.ensureDir(newPath);
    const size = statSync(oldFull).size;
    renameSync(oldFull, newFull);
    this.diskUsage.recordRemove(this.getDirName(oldPath), size);
    this.diskUsage.recordAdd(this.getDirName(newPath), size);
  }

  /**
   * 复制文件，记录增量
   */
  copyFile(srcPath: string, destPath: string): void {
    const srcFull = this.resolve(srcPath);
    const destFull = this.resolve(destPath);
    this.ensureDir(destPath);
    copyFileSync(srcFull, destFull);
    this.trackAdd(destPath);
  }

  /**
   * 获取文件 stat（不追踪）
   */
  stat(relativePath: string): { size: number; mtimeMs: number } | null {
    const fullPath = this.resolve(relativePath);
    if (!existsSync(fullPath)) return null;
    const s = statSync(fullPath);
    return { size: s.size, mtimeMs: s.mtimeMs };
  }

  /**
   * 检查文件是否存在
   */
  exists(relativePath: string): boolean {
    return existsSync(this.resolve(relativePath));
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
  private trackAdd(relativePath: string): void {
    const fullPath = this.resolve(relativePath);
    const size = statSync(fullPath).size;
    const dirName = this.getDirName(relativePath);
    this.diskUsage.recordAdd(dirName, size);
  }

  /** 记录文件删除，返回文件大小 */
  private trackRemove(relativePath: string): number {
    const fullPath = this.resolve(relativePath);
    const size = existsSync(fullPath) ? statSync(fullPath).size : 0;
    const dirName = this.getDirName(relativePath);
    this.diskUsage.recordRemove(dirName, size);
    return size;
  }

  /** 从相对路径提取一级子目录名 */
  private getDirName(relativePath: string): string {
    /** "recordings/cam1/file.mp4" → "recordings" */
    return relativePath.split("/")[0] ?? "unknown";
  }
}
