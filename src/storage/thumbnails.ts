import { spawn } from "node:child_process";
import { type StorageFs } from "@/storage/storage-fs";

/** 缩略图尺寸 */
const THUMB_WIDTH = 320;
const THUMB_HEIGHT = 180;

/**
 * 录像缩略图生成器
 * 使用 ffmpeg 从 MP4 提取指定时间点的帧，缓存到磁盘
 * 通过 StorageFs 统一管理文件 I/O
 */
export class ThumbnailGenerator {
  private ffmpegPath: string;
  private storageFs: StorageFs;
  /** 正在生成中的缩略图（防止重复请求） */
  private pending = new Map<string, Promise<string | null>>();
  private static readonly CATEGORY = "thumbnails";

  constructor(_cacheDir: string, ffmpegPath: string, storageFs: StorageFs) {
    this.ffmpegPath = ffmpegPath;
    this.storageFs = storageFs;
  }

  /**
   * 异步获取缩略图路径（如果不存在则生成）
   */
  async getOrCreateAsync(videoPath: string, timeSeconds: number): Promise<string | null> {
    const key = this.cacheKey(videoPath, timeSeconds);
    const relativePath = `${ThumbnailGenerator.CATEGORY}/${key}`;
    const exists = await this.storageFs.exists(relativePath);
    if (exists) return this.storageFs.resolve(relativePath);

    /** 去重：如果同一个缩略图正在生成中，复用同一个 Promise */
    const existing = this.pending.get(key);
    if (existing) return existing;

    const promise = this.generateAsync(videoPath, timeSeconds, relativePath)
      .finally(() => { this.pending.delete(key); });
    this.pending.set(key, promise);
    return promise;
  }

  /** 异步生成缩略图 */
  private async generateAsync(videoPath: string, timeSeconds: number, relativePath: string): Promise<string | null> {
    await this.storageFs.ensureDir(relativePath);

    const result = await this.runFfmpegAsync(videoPath, timeSeconds, relativePath);
    if (result) {
      /** 注册到索引 */
      const fileInfo = await this.storageFs.stat(relativePath);
      if (fileInfo) {
        this.storageFs.fileIndex.registerFile({
          category: ThumbnailGenerator.CATEGORY,
          relativePath,
          size: fileInfo.size,
          mtimeMs: fileInfo.mtimeMs,
          createdAt: fileInfo.mtimeMs,
        });
      }
      return result;
    }

    /** seek 超出视频时长时回退到开头 */
    if (timeSeconds > 0) return this.runFfmpegAsync(videoPath, 0, relativePath);
    console.warn(`[Thumbnails] ffmpeg 截帧失败: ${videoPath}@${timeSeconds}s`);
    return null;
  }

  /** 异步执行 ffmpeg 截帧 */
  private runFfmpegAsync(videoPath: string, timeSeconds: number, relativePath: string): Promise<string | null> {
    const outputPath = this.storageFs.resolve(relativePath);
    return new Promise((resolve) => {
      const args = [
        "-ss", String(Math.max(0, timeSeconds)),
        "-i", videoPath,
        "-vframes", "1",
        "-vf", `scale=${THUMB_WIDTH}:${THUMB_HEIGHT}:force_original_aspect_ratio=decrease,pad=${THUMB_WIDTH}:${THUMB_HEIGHT}:(ow-iw)/2:(oh-ih)/2:black`,
        "-q:v", "4",
        "-y",
        outputPath,
      ];

      const proc = spawn(this.ffmpegPath, args, { stdio: "ignore" });

      /** 5 秒超时保护 */
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve(null);
      }, 5000);

      proc.on("exit", async (code) => {
        clearTimeout(timer);
        proc.unref();
        if (code === 0) {
          const exists = await this.storageFs.exists(relativePath);
          resolve(exists ? outputPath : null);
        } else {
          resolve(null);
        }
      });

      proc.on("error", () => {
        clearTimeout(timer);
        resolve(null);
      });
    });
  }

  /** 生成缓存 key */
  private cacheKey(videoPath: string, timeSeconds: number): string {
    let hash = 0;
    for (let i = 0; i < videoPath.length; i++) {
      hash = ((hash << 5) - hash + videoPath.charCodeAt(i)) | 0;
    }
    return `${hash.toString(36)}_${Math.round(timeSeconds)}.jpg`;
  }

  /** 删除所有缩略图缓存 */
  async purgeAll(): Promise<number> {
    return this.storageFs.deleteAllFiles(ThumbnailGenerator.CATEGORY);
  }

  /** 清理过期缓存（超过 retentionDays 天的） */
  async purge(retentionDays: number): Promise<number> {
    const cutoff = Date.now() - retentionDays * 86_400_000;
    return this.storageFs.deleteExpiredFiles(ThumbnailGenerator.CATEGORY, cutoff);
  }

  /**
   * 批量预生成缩略图
   */
  async pregenerateAsync(videoPaths: Array<{ path: string; durationSec: number }>): Promise<void> {
    for (const { path, durationSec } of videoPaths) {
      const timeSec = Math.max(0, durationSec / 2);
      await this.getOrCreateAsync(path, timeSec);
    }
  }
}
