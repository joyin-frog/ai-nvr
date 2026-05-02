import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";

/** 缩略图尺寸 */
const THUMB_WIDTH = 320;
const THUMB_HEIGHT = 180;

/**
 * 录像缩略图生成器
 * 使用 ffmpeg 从 MP4 提取指定时间点的帧，缓存到磁盘
 * 异步生成，不阻塞事件循环
 */
export class ThumbnailGenerator {
  private cacheDir: string;
  private ffmpegPath: string;
  /** 正在生成中的缩略图（防止重复请求） */
  private pending = new Map<string, Promise<string | null>>();

  constructor(cacheDir: string, ffmpegPath: string) {
    this.cacheDir = cacheDir;
    this.ffmpegPath = ffmpegPath;
    mkdirSync(cacheDir, { recursive: true });
  }

  /**
   * 异步获取缩略图路径（如果不存在则生成）
   * @param videoPath MP4 文件绝对路径
   * @param timeSeconds 视频内时间点（秒）
   * @returns 缩略图文件绝对路径，或 null 表示生成失败
   */
  async getOrCreateAsync(videoPath: string, timeSeconds: number): Promise<string | null> {
    const key = this.cacheKey(videoPath, timeSeconds);
    const thumbPath = join(this.cacheDir, key);

    if (existsSync(thumbPath)) return thumbPath;

    /** 去重：如果同一个缩略图正在生成中，复用同一个 Promise */
    const pendingKey = key;
    const existing = this.pending.get(pendingKey);
    if (existing) return existing;

    const promise = this.generateAsync(videoPath, timeSeconds, thumbPath)
      .finally(() => { this.pending.delete(pendingKey); });
    this.pending.set(pendingKey, promise);
    return promise;
  }

  /** 异步生成缩略图 */
  private async generateAsync(videoPath: string, timeSeconds: number, outputPath: string): Promise<string | null> {
    if (!existsSync(videoPath)) return null;

    mkdirSync(dirname(outputPath), { recursive: true });

    const result = await this.runFfmpegAsync(videoPath, timeSeconds, outputPath);
    if (result) return result;

    /** seek 超出视频时长时回退到开头 */
    if (timeSeconds > 0) return this.runFfmpegAsync(videoPath, 0, outputPath);
    return null;
  }

  /** 异步执行 ffmpeg 截帧 */
  private runFfmpegAsync(videoPath: string, timeSeconds: number, outputPath: string): Promise<string | null> {
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

      proc.on("exit", (code) => {
        clearTimeout(timer);
        resolve(code === 0 && existsSync(outputPath) ? outputPath : null);
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

  /** 删除所有缩略图缓存，返回删除的文件数量 */
  purgeAll(): number {
    let count = 0;
    const files = readdirSync(this.cacheDir);
    for (const file of files) {
      const filePath = join(this.cacheDir, file);
      unlinkSync(filePath);
      count++;
    }
    return count;
  }

  /** 清理过期缓存（超过 retentionDays 天的） */
  purge(retentionDays: number): void {
    const cutoff = Date.now() - retentionDays * 86_400_000;
    try {
      const files = readdirSync(this.cacheDir);
      for (const file of files) {
        const filePath = join(this.cacheDir, file);
        const stat = statSync(filePath);
        if (stat.mtimeMs < cutoff) {
          unlinkSync(filePath);
        }
      }
    } catch {
      // ignore
    }
  }

  /**
   * 批量预生成缩略图（真正异步，不阻塞事件循环）
   * 串行执行避免并发 ffmpeg 进程过多占用资源
   */
  async pregenerateAsync(videoPaths: Array<{ path: string; durationSec: number }>): Promise<void> {
    for (const { path, durationSec } of videoPaths) {
      const timeSec = Math.max(0, durationSec / 2);
      await this.getOrCreateAsync(path, timeSec);
    }
  }
}
