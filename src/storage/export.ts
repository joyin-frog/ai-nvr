import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/** 导出任务结果 */
export interface ExportResult {
  /** 导出文件绝对路径 */
  filePath: string;
  /** 文件大小（bytes） */
  size: number;
}

/**
 * 录像导出器
 * 使用 ffmpeg 裁剪视频片段，输出到临时目录供下载
 */
export class RecordingExporter {
  private exportDir: string;
  private ffmpegPath: string;

  constructor(exportDir: string, ffmpegPath: string) {
    this.exportDir = exportDir;
    this.ffmpegPath = ffmpegPath;
    mkdirSync(exportDir, { recursive: true });
  }

  /**
   * 导出视频片段
   * @param sourcePath 源 MP4 文件绝对路径
   * @param startTimeSec 起始时间（秒，相对于视频开始）
   * @param endTimeSec 结束时间（秒，相对于视频开始）
   * @param cameraId 摄像头 ID（用于文件命名）
   * @returns 导出结果
   */
  export(sourcePath: string, startTimeSec: number, endTimeSec: number, cameraId: string): ExportResult | null {
    if (!existsSync(sourcePath)) return null;

    const duration = endTimeSec - startTimeSec;
    if (duration <= 0) return null;

    /** 生成文件名：cameraId_导出时间戳.mp4 */
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toISOString().slice(11, 19).replace(/:/g, "-");
    const filename = `export_${cameraId}_${dateStr}_${timeStr}.mp4`;
    const outputPath = join(this.exportDir, filename);

    /** ffmpeg 精确裁剪：-ss 放在 -i 前面（快速 seek） */
    const args = [
      "-ss", String(Math.max(0, startTimeSec)),
      "-to", String(endTimeSec),
      "-i", sourcePath,
      "-c", "copy",
      "-movflags", "+faststart",
      "-y",
      outputPath,
    ];

    const result = spawnSync(this.ffmpegPath, args, {
      timeout: 30_000,
      stdio: "ignore",
    });

    if (result.status !== 0 || !existsSync(outputPath)) return null;

    const stat = statSync(outputPath);
    return { filePath: outputPath, size: stat.size };
  }

  /** 获取导出文件路径（供下载服务使用） */
  getExportPath(filename: string): string {
    return join(this.exportDir, filename);
  }

  /** 列出所有导出文件 */
  listExports(): Array<{ filename: string; size: number; createdAt: number }> {
    const results: Array<{ filename: string; size: number; createdAt: number }> = [];
    try {
      const files = readdirSync(this.exportDir);
      for (const file of files) {
        if (!file.startsWith("export_") || !file.endsWith(".mp4")) continue;
        const filePath = join(this.exportDir, file);
        const stat = statSync(filePath);
        results.push({ filename: file, size: stat.size, createdAt: stat.mtimeMs });
      }
    } catch {
      // ignore
    }
    return results.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** 清理超过指定小时的导出文件 */
  purge(maxAgeHours: number): number {
    const cutoff = Date.now() - maxAgeHours * 3600_000;
    let removed = 0;
    try {
      const files = readdirSync(this.exportDir);
      for (const file of files) {
        if (!file.startsWith("export_")) continue;
        const filePath = join(this.exportDir, file);
        const stat = statSync(filePath);
        if (stat.mtimeMs < cutoff) {
          unlinkSync(filePath);
          removed++;
        }
      }
    } catch {
      // ignore
    }
    return removed;
  }
}
