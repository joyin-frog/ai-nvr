import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync, createWriteStream, rmSync } from "node:fs";
import { join, basename } from "node:path";
import * as archiver from "archiver";

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
 * 全部异步，不阻塞事件循环
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
   * 异步导出视频片段
   * @param sourcePath 源 MP4 文件绝对路径
   * @param startTimeSec 起始时间（秒，相对于视频开始）
   * @param endTimeSec 结束时间（秒，相对于视频开始）
   * @param cameraId 摄像头 ID（用于文件命名）
   * @returns 导出结果
   */
  async exportAsync(sourcePath: string, startTimeSec: number, endTimeSec: number, cameraId: string): Promise<ExportResult | null> {
    if (!existsSync(sourcePath)) return null;

    const duration = endTimeSec - startTimeSec;
    if (duration <= 0) return null;

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

    const ok = await this.runFfmpeg(args, 30_000);
    if (!ok || !existsSync(outputPath)) return null;

    const stat = statSync(outputPath);
    return { filePath: outputPath, size: stat.size };
  }

  /** 获取导出文件路径（供下载服务使用） */
  getExportPath(filename: string): string {
    return join(this.exportDir, filename);
  }

  /**
   * 异步合并多个视频文件为一个
   * 使用 ffmpeg concat demuxer，要求输入文件编码参数一致
   */
  async mergeAsync(sourcePaths: string[], cameraId: string): Promise<ExportResult | null> {
    if (sourcePaths.length === 0) return null;

    /** 单文件直接复制 */
    if (sourcePaths.length === 1) {
      const src = sourcePaths[0]!;
      if (!existsSync(src)) return null;
      const now = new Date();
      const dateStr = now.toISOString().slice(0, 10);
      const timeStr = now.toISOString().slice(11, 19).replace(/:/g, "-");
      const filename = `export_${cameraId}_${dateStr}_${timeStr}.mp4`;
      const outputPath = join(this.exportDir, filename);
      const args = ["-i", src, "-c", "copy", "-movflags", "+faststart", "-y", outputPath];
      const ok = await this.runFfmpeg(args, 30_000);
      if (!ok || !existsSync(outputPath)) return null;
      return { filePath: outputPath, size: statSync(outputPath).size };
    }

    /** 验证所有文件存在 */
    for (const p of sourcePaths) {
      if (!existsSync(p)) return null;
    }

    /** 生成 concat 列表文件 */
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toISOString().slice(11, 19).replace(/:/g, "-");
    const outputFilename = `export_${cameraId}_${dateStr}_${timeStr}.mp4`;
    const outputPath = join(this.exportDir, outputFilename);
    const concatListPath = join(this.exportDir, `_concat_${dateStr}_${timeStr}.txt`);

    const lines = sourcePaths.map(p => `file '${p}'`);
    writeFileSync(concatListPath, lines.join("\n"));

    const args = [
      "-f", "concat",
      "-safe", "0",
      "-i", concatListPath,
      "-c", "copy",
      "-movflags", "+faststart",
      "-y",
      outputPath,
    ];

    const ok = await this.runFfmpeg(args, 60_000);

    /** 清理 concat 列表文件 */
    try { unlinkSync(concatListPath); } catch { /* ignore */ }

    if (!ok || !existsSync(outputPath)) return null;

    return { filePath: outputPath, size: statSync(outputPath).size };
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

  /**
   * 异步将视频片段导出为 GIF 动图
   * 使用 ffmpeg palettegen/paletteuse 双 pass 生成高质量调色板
   */
  async toGifAsync(sourcePath: string, startTimeSec: number, endTimeSec: number, cameraId: string, maxWidth = 480): Promise<ExportResult | null> {
    if (!existsSync(sourcePath)) return null;

    const duration = endTimeSec - startTimeSec;
    if (duration <= 0) return null;

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toISOString().slice(11, 19).replace(/:/g, "-");
    const filename = `export_${cameraId}_${dateStr}_${timeStr}.gif`;
    const outputPath = join(this.exportDir, filename);
    const palettePath = join(this.exportDir, `_palette_${dateStr}_${timeStr}.png`);

    /** Pass 1: 生成调色板 */
    const paletteArgs = [
      "-ss", String(Math.max(0, startTimeSec)),
      "-to", String(endTimeSec),
      "-i", sourcePath,
      "-vf", `fps=10,scale=${maxWidth}:-1:flags=lanczos,palettegen=max_colors=128`,
      "-y",
      palettePath,
    ];
    const paletteOk = await this.runFfmpeg(paletteArgs, 30_000);
    if (!paletteOk || !existsSync(palettePath)) return null;

    /** Pass 2: 使用调色板生成 GIF */
    const gifArgs = [
      "-ss", String(Math.max(0, startTimeSec)),
      "-to", String(endTimeSec),
      "-i", sourcePath,
      "-i", palettePath,
      "-lavfi", `fps=10,scale=${maxWidth}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer`,
      "-y",
      outputPath,
    ];
    const gifOk = await this.runFfmpeg(gifArgs, 60_000);

    /** 清理临时调色板 */
    try { unlinkSync(palettePath); } catch { /* ignore */ }

    if (!gifOk || !existsSync(outputPath)) return null;

    return { filePath: outputPath, size: statSync(outputPath).size };
  }

  /**
   * 批量打包录像为 ZIP 文件
   */
  async zipBatch(sourcePaths: string[], cameraId: string): Promise<ExportResult | null> {
    if (sourcePaths.length === 0) return null;

    for (const p of sourcePaths) {
      if (!existsSync(p)) return null;
    }

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toISOString().slice(11, 19).replace(/:/g, "-");
    const filename = `export_${cameraId}_${dateStr}_${timeStr}.zip`;
    const outputPath = join(this.exportDir, filename);

    return new Promise((resolve) => {
      const output = createWriteStream(outputPath);
      const archive = archiver.create("zip", { zlib: { level: 1 } });

      output.on("close", () => {
        if (!existsSync(outputPath)) { resolve(null); return; }
        const stat = statSync(outputPath);
        resolve({ filePath: outputPath, size: stat.size });
      });

      archive.on("error", () => {
        try { unlinkSync(outputPath); } catch { /* ignore */ }
        resolve(null);
      });

      archive.pipe(output);

      for (const p of sourcePaths) {
        archive.file(p, { name: basename(p) });
      }

      archive.finalize();
    });
  }

  /** 删除所有导出文件，返回删除的文件数量 */
  purgeAll(): number {
    let count = 0;
    const files = readdirSync(this.exportDir);
    for (const file of files) {
      const filePath = join(this.exportDir, file);
      const stat = statSync(filePath);
      if (stat.isDirectory()) {
        rmSync(filePath, { recursive: true, force: true });
      } else {
        unlinkSync(filePath);
      }
      count++;
    }
    return count;
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

  /** 异步执行 ffmpeg 命令 */
  private runFfmpeg(args: string[], timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn(this.ffmpegPath, args, { stdio: "ignore" });

      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve(false);
      }, timeoutMs);

      proc.on("exit", (code) => {
        clearTimeout(timer);
        proc.unref();
        resolve(code === 0);
      });

      proc.on("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
  }
}
