import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";

/** 缩略图尺寸 */
const THUMB_WIDTH = 320;
const THUMB_HEIGHT = 180;

/**
 * 录像缩略图生成器
 * 使用 ffmpeg 从 MP4 提取指定时间点的帧，缓存到磁盘
 */
export class ThumbnailGenerator {
  private cacheDir: string;
  private ffmpegPath: string;

  constructor(cacheDir: string, ffmpegPath: string) {
    this.cacheDir = cacheDir;
    this.ffmpegPath = ffmpegPath;
    mkdirSync(cacheDir, { recursive: true });
  }

  /**
   * 获取缩略图路径（如果不存在则生成）
   * @param videoPath MP4 文件绝对路径
   * @param timeSeconds 视频内时间点（秒）
   * @returns 缩略图文件绝对路径，或 null 表示生成失败
   */
  getOrCreate(videoPath: string, timeSeconds: number): string | null {
    /** 缓存 key：视频路径哈希 + 时间点 */
    const key = this.cacheKey(videoPath, timeSeconds);
    const thumbPath = join(this.cacheDir, key);

    if (existsSync(thumbPath)) return thumbPath;

    return this.generate(videoPath, timeSeconds, thumbPath);
  }

  /** 生成缩略图 */
  private generate(videoPath: string, timeSeconds: number, outputPath: string): string | null {
    if (!existsSync(videoPath)) return null;

    mkdirSync(dirname(outputPath), { recursive: true });

    const result = this.runFfmpeg(videoPath, timeSeconds, outputPath);
    if (result) return result;

    /** seek 超出视频时长时回退到开头 */
    if (timeSeconds > 0) return this.runFfmpeg(videoPath, 0, outputPath);
    return null;
  }

  /** 执行 ffmpeg 截帧 */
  private runFfmpeg(videoPath: string, timeSeconds: number, outputPath: string): string | null {
    const args = [
      "-ss", String(Math.max(0, timeSeconds)),
      "-i", videoPath,
      "-vframes", "1",
      "-vf", `scale=${THUMB_WIDTH}:${THUMB_HEIGHT}:force_original_aspect_ratio=decrease,pad=${THUMB_WIDTH}:${THUMB_HEIGHT}:(ow-iw)/2:(oh-ih)/2:black`,
      "-q:v", "4",
      "-y",
      outputPath,
    ];

    const result = spawnSync(this.ffmpegPath, args, {
      timeout: 5000,
      stdio: "ignore",
    });

    if (result.status !== 0 || !existsSync(outputPath)) return null;
    return outputPath;
  }

  /** 生成缓存 key */
  private cacheKey(videoPath: string, timeSeconds: number): string {
    /** 用简单的路径哈希避免文件名冲突 */
    let hash = 0;
    for (let i = 0; i < videoPath.length; i++) {
      hash = ((hash << 5) - hash + videoPath.charCodeAt(i)) | 0;
    }
    return `${hash.toString(36)}_${Math.round(timeSeconds)}.jpg`;
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
   * 批量预生成缩略图（异步，不阻塞调用方）
   * 跳过已有缓存的文件，只生成缺失的
   */
  pregenerate(videoPaths: Array<{ path: string; durationSec: number }>): void {
    /** 不阻塞，让 ffmpeg 在后台逐个生成 */
    setTimeout(() => {
      for (const { path, durationSec } of videoPaths) {
        const timeSec = Math.max(0, durationSec / 2)
        this.getOrCreate(path, timeSec)
      }
    }, 0)
  }
}
