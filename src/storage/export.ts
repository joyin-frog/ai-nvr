import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { join, basename } from "node:path";
import * as archiver from "archiver";
import { type StorageFs } from "@/storage/storage-fs";

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
 * 通过 StorageFs 统一管理文件 I/O 和索引
 */
export class RecordingExporter {
  private exportDir: string;
  private ffmpegPath: string;
  private storageFs: StorageFs;
  private static readonly CATEGORY = "exports";

  constructor(exportDir: string, ffmpegPath: string, storageFs: StorageFs) {
    this.exportDir = exportDir;
    this.ffmpegPath = ffmpegPath;
    this.storageFs = storageFs;
  }

  /**
   * 异步导出视频片段
   */
  async exportAsync(sourcePath: string, startTimeSec: number, endTimeSec: number, cameraId: string): Promise<ExportResult | null> {
    const sourceExists = await this.storageFs.exists(sourcePath.startsWith("/") ? sourcePath.replace(this.storageFs.root + "/", "") : sourcePath);
    if (!sourceExists) return null;

    const duration = endTimeSec - startTimeSec;
    if (duration <= 0) return null;

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toISOString().slice(11, 19).replace(/:/g, "-");
    const filename = `export_${cameraId}_${dateStr}_${timeStr}.mp4`;
    const outputPath = join(this.exportDir, filename);

    /** ffmpeg 精确裁剪 */
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
    if (!ok) return null;

    const fileInfo = await this.storageFs.stat(`${RecordingExporter.CATEGORY}/${filename}`);
    if (!fileInfo) return null;

    await this.registerExport(filename, cameraId, fileInfo.size, fileInfo.mtimeMs);
    return { filePath: outputPath, size: fileInfo.size };
  }

  /** 获取导出文件路径（供下载服务使用） */
  getExportPath(filename: string): string {
    return join(this.exportDir, filename);
  }

  /**
   * 异步合并多个视频文件为一个
   */
  async mergeAsync(sourcePaths: string[], cameraId: string): Promise<ExportResult | null> {
    if (sourcePaths.length === 0) return null;

    /** 单文件直接复制 */
    if (sourcePaths.length === 1) {
      const src = sourcePaths[0]!;
      const srcExists = await this.storageFs.exists(src);
      if (!srcExists) return null;

      const now = new Date();
      const dateStr = now.toISOString().slice(0, 10);
      const timeStr = now.toISOString().slice(11, 19).replace(/:/g, "-");
      const filename = `export_${cameraId}_${dateStr}_${timeStr}.mp4`;
      const outputPath = join(this.exportDir, filename);
      const args = ["-i", src, "-c", "copy", "-movflags", "+faststart", "-y", outputPath];
      const ok = await this.runFfmpeg(args, 30_000);
      if (!ok) return null;

      const fileInfo = await this.storageFs.stat(`${RecordingExporter.CATEGORY}/${filename}`);
      if (!fileInfo) return null;

      await this.registerExport(filename, cameraId, fileInfo.size, fileInfo.mtimeMs);
      return { filePath: outputPath, size: fileInfo.size };
    }

    /** 验证所有文件存在 */
    for (const p of sourcePaths) {
      const exists = await this.storageFs.exists(p);
      if (!exists) return null;
    }

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toISOString().slice(11, 19).replace(/:/g, "-");
    const outputFilename = `export_${cameraId}_${dateStr}_${timeStr}.mp4`;
    const outputPath = join(this.exportDir, outputFilename);
    const concatListPath = join(this.exportDir, `_concat_${dateStr}_${timeStr}.txt`);

    const lines = sourcePaths.map(p => `file '${p}'`);
    await this.storageFs.writeFile(`${RecordingExporter.CATEGORY}/../_concat_${dateStr}_${timeStr}.txt`, lines.join("\n"));

    /** 写 concat 文件（临时，不用索引） */
    const { writeFile: writeFileSync, unlink: unlinkAsync } = await import("node:fs/promises");
    await writeFileSync(concatListPath, lines.join("\n"));

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
    try { await unlinkAsync(concatListPath); } catch { /* ignore */ }

    if (!ok) return null;

    const fileInfo = await this.storageFs.stat(`${RecordingExporter.CATEGORY}/${outputFilename}`);
    if (!fileInfo) return null;

    await this.registerExport(outputFilename, cameraId, fileInfo.size, fileInfo.mtimeMs);
    return { filePath: outputPath, size: fileInfo.size };
  }

  /** 列出所有导出文件 — 从 SQLite 索引查询 */
  listExports(): Array<{ filename: string; size: number; createdAt: number }> {
    return this.storageFs.fileIndex.listFiles({ category: RecordingExporter.CATEGORY })
      .map(e => ({
        filename: e.relativePath,
        size: e.size,
        createdAt: e.createdAt ?? e.mtimeMs,
      }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * 异步将视频片段导出为 GIF 动图
   */
  async toGifAsync(sourcePath: string, startTimeSec: number, endTimeSec: number, cameraId: string, maxWidth = 480): Promise<ExportResult | null> {
    const sourceExists = await this.storageFs.exists(sourcePath);
    if (!sourceExists) return null;

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
    if (!paletteOk) return null;

    const paletteExists = await this.storageFs.exists(palettePath);
    if (!paletteExists) return null;

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
    try { const { unlink: ul } = await import("node:fs/promises"); await ul(palettePath); } catch { /* ignore */ }

    if (!gifOk) return null;

    const fileInfo = await this.storageFs.stat(`${RecordingExporter.CATEGORY}/${filename}`);
    if (!fileInfo) return null;

    await this.registerExport(filename, cameraId, fileInfo.size, fileInfo.mtimeMs);
    return { filePath: outputPath, size: fileInfo.size };
  }

  /**
   * 批量打包录像为 ZIP 文件
   */
  async zipBatch(sourcePaths: string[], cameraId: string): Promise<ExportResult | null> {
    if (sourcePaths.length === 0) return null;

    for (const p of sourcePaths) {
      const exists = await this.storageFs.exists(p);
      if (!exists) return null;
    }

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toISOString().slice(11, 19).replace(/:/g, "-");
    const filename = `export_${cameraId}_${dateStr}_${timeStr}.zip`;
    const outputPath = join(this.exportDir, filename);

    return new Promise((resolve) => {
      const output = createWriteStream(outputPath);
      const archive = archiver.create("zip", { zlib: { level: 1 } });

      output.on("close", async () => {
        const fileInfo = await this.storageFs.stat(`${RecordingExporter.CATEGORY}/${filename}`);
        if (!fileInfo) { resolve(null); return; }
        await this.registerExport(filename, cameraId, fileInfo.size, fileInfo.mtimeMs);
        resolve({ filePath: outputPath, size: fileInfo.size });
      });

      archive.on("error", async () => {
        try { const { unlink: ul } = await import("node:fs/promises"); await ul(outputPath); } catch { /* ignore */ }
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
  async purgeAll(): Promise<number> {
    return this.storageFs.deleteAllFiles(RecordingExporter.CATEGORY);
  }

  /** 清理超过指定小时的导出文件 */
  async purge(maxAgeHours: number): Promise<number> {
    const cutoff = Date.now() - maxAgeHours * 3600_000;
    return this.storageFs.deleteExpiredFiles(RecordingExporter.CATEGORY, cutoff);
  }

  /** 注册导出文件到索引 */
  private async registerExport(filename: string, cameraId: string, size: number, mtimeMs: number): Promise<void> {
    this.storageFs.fileIndex.registerFile({
      category: RecordingExporter.CATEGORY,
      relativePath: filename,
      cameraId,
      size,
      mtimeMs,
      createdAt: mtimeMs,
    });
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
