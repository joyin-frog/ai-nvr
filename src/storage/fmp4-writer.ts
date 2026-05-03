import { spawn } from "node:child_process";
import { open, type FileHandle } from "node:fs/promises";
import { type Fmp4InitSegment } from "@/camera/h264-fmp4-muxer";

/** drawtext 水印默认字体路径 */
const DEFAULT_FONT = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc";

/**
 * fMP4 → MP4 文件写入器
 * 将 fMP4 init segment + media segments 拼接写入 MP4 文件
 *
 * 两种模式：
 * - 无水印：直接拼接 fMP4 数据（零转码），文件结构为 [ftyp+moov]+[moof+mdat]*...
 * - 有水印：通过 ffmpeg pipe 转码添加 drawtext 滤镜
 */
export class Fmp4Writer {
  private fileHandle: FileHandle | null = null;
  /** ffmpeg 转码进程（仅水印模式） */
  private ffmpegProc: ReturnType<typeof spawn> | null = null;
  /** 是否已完成初始化写入 */
  private initialized = false;
  /** 是否已关闭 */
  private closed = false;
  /** 写入模式 */
  private readonly mode: "direct" | "transcode";

  private constructor(
    _outputPath: string,
    mode: "direct" | "transcode",
  ) {
    this.mode = mode;
  }

  /**
   * 创建直接写入模式的 writer（零转码）
   * 将 fMP4 数据直接写入文件，无需 ffmpeg 进程
   */
  static async createDirect(outputPath: string): Promise<Fmp4Writer> {
    const writer = new Fmp4Writer(outputPath, "direct");
    writer.fileHandle = await open(outputPath, "w");
    return writer;
  }

  /**
   * 创建转码写入模式的 writer（带水印）
   * 启动 ffmpeg 进程，从 stdin 读取 fMP4，添加 drawtext 滤镜后输出 MP4
   */
  static async createTranscode(
    outputPath: string,
    ffmpegPath: string,
    watermarkFilter: string,
    encoderArgs: string[],
  ): Promise<Fmp4Writer> {
    const writer = new Fmp4Writer(outputPath, "transcode");

    const args = [
      "-f", "mp4",
      "-i", "pipe:0",
      "-vf", watermarkFilter,
      ...encoderArgs,
      "-movflags", "+faststart",
      "-an",
      "-y",
      outputPath,
    ];

    writer.ffmpegProc = spawn(ffmpegPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    writer.ffmpegProc.stderr?.on("data", (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg.includes("error") || msg.includes("Error")) {
        console.error("[Fmp4Writer] ffmpeg error:", msg);
      }
    });

    writer.ffmpegProc.stdin?.on("error", () => {});

    return writer;
  }

  /** 写入 init segment（ftyp + moov） */
  async writeInit(initSegment: Fmp4InitSegment): Promise<void> {
    if (this.closed || this.initialized) return;

    if (this.mode === "direct") {
      await this.fileHandle!.write(initSegment.data);
    } else {
      const stdin = this.ffmpegProc?.stdin;
      if (stdin?.writable) {
        stdin.write(initSegment.data);
      }
    }
    this.initialized = true;
  }

  /** 追加写入一个 media segment（moof + mdat） */
  async appendSegment(moofData: Buffer, mdatData: Buffer): Promise<void> {
    if (this.closed || !this.initialized) return;

    if (this.mode === "direct") {
      await this.fileHandle!.write(moofData);
      await this.fileHandle!.write(mdatData);
    } else {
      const stdin = this.ffmpegProc?.stdin;
      if (stdin?.writable) {
        stdin.write(moofData);
        stdin.write(mdatData);
      }
    }
  }

  /** 关闭写入器，完成文件 */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    if (this.mode === "direct") {
      await this.fileHandle?.close();
      this.fileHandle = null;
    } else {
      const stdin = this.ffmpegProc?.stdin;
      if (stdin) {
        stdin.end();
      }
      /** 等待 ffmpeg 进程退出 */
      if (this.ffmpegProc) {
        await new Promise<void>((resolve) => {
          this.ffmpegProc!.on("exit", () => {
            this.ffmpegProc?.unref();
            this.ffmpegProc = null;
            resolve();
          });
        });
      }
    }
  }

  /** 强制关闭（不等 ffmpeg 优雅退出） */
  forceClose(): void {
    if (this.closed) return;
    this.closed = true;

    if (this.mode === "direct") {
      this.fileHandle?.close().catch(() => {});
      this.fileHandle = null;
    } else {
      if (this.ffmpegProc) {
        this.ffmpegProc.stdin?.destroy();
        this.ffmpegProc.kill("SIGKILL");
        this.ffmpegProc.unref();
        this.ffmpegProc = null;
      }
    }
  }

  /** 构建摄像头名称水印的 drawtext 滤镜字符串 */
  static buildWatermarkFilter(
    cameraName: string | undefined,
    watermarkConfig: {
      enabled: boolean;
      fontSize: number;
      namePosition: string;
      timePosition: string;
    },
  ): string {
    const filterParts: string[] = [];

    const posCoords = (pos: string) => {
      switch (pos) {
        case "top-right": return { x: "w-tw-10", y: "10" };
        case "bottom-left": return { x: "10", y: "h-th-10" };
        case "bottom-right": return { x: "w-tw-10", y: "h-th-10" };
        default: return { x: "10", y: "10" };
      }
    };

    if (cameraName) {
      const safeName = cameraName.replace(/'/g, "'\\''");
      const { x, y } = posCoords(watermarkConfig.namePosition);
      filterParts.push(
        `drawtext=fontfile='${DEFAULT_FONT}':text='${safeName}':x=${x}:y=${y}:fontsize=${watermarkConfig.fontSize + 4}:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=4`,
      );
    }
    const { x, y } = posCoords(watermarkConfig.timePosition);
    const timeText = "%{localtime\\:%Y-%m-%d %H\\:%M\\:%S}";
    filterParts.push(
      `drawtext=fontfile='${DEFAULT_FONT}':text='${timeText}':x=${x}:y=${y}:fontsize=${watermarkConfig.fontSize}:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=4`,
    );

    return filterParts.join(",");
  }
}
