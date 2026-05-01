import { spawn } from "node:child_process";
import { type CameraConfig } from "@/config";
import { type EventBus } from "@/event-bus";

/** JPEG 帧起始标记 */
const JPEG_START = 0xff;
const JPEG_SOI = 0xd8;
const JPEG_EOI = 0xd9;

/**
 * 从 ffmpeg stdout 的 MJPEG 字节流中分割出独立的 JPEG 帧
 *
 * JPEG 格式：FF D8 ... (帧数据) ... FF D9
 * 帧数据中 0xFF 如果后面跟着 0x00 则是填充（stuffing byte），
 * 不是标记。其他标记（D0-D7 是 RST、00 是填充）都直接包含在帧数据中。
 *
 * 策略：扫描 FF D8 作为帧起始，扫描 FF D9 作为帧结束，
 * 对于帧数据中的 FF，如果不是 SOI/EOI 标记，原样保留。
 */
class JpegFrameSplitter {
  /** 当前正在拼接的帧 chunks */
  private chunks: Buffer[] = [];
  /** 当前帧已收集的字节数 */
  private frameSize = 0;
  /** 是否在帧内 */
  private inFrame = false;

  /** 处理一块数据，返回完整帧列表 */
  feed(data: Buffer): Buffer[] {
    const frames: Buffer[] = [];
    let i = 0;

    while (i < data.length) {
      /** 扫描 0xFF */
      if (data[i] === JPEG_START && i + 1 < data.length) {
        const marker = data[i + 1]!;

        if (marker === JPEG_SOI) {
          /** 帧开始 FF D8 */
          this.inFrame = true;
          this.chunks = [];
          this.frameSize = 0;
          this.pushBytes(data, i, 2);
          i += 2;
          continue;
        }

        if (marker === JPEG_EOI && this.inFrame) {
          /** 帧结束 FF D9 */
          this.pushBytes(data, i, 2);
          const frame = Buffer.concat(this.chunks, this.frameSize);
          frames.push(frame);
          this.inFrame = false;
          this.chunks = [];
          this.frameSize = 0;
          i += 2;
          continue;
        }

        /**
         * 其他情况：FF 后跟 D0-D7（RST 标记）、00（填充）、
         * 或其他标记字节（如 C0 量化表、DA 扫描头等），
         * 这些都是合法的帧内数据，直接追加。
         * 注意：FF 后面可能还是 FF（连续 FF），
         * 只追加当前 FF 和下一个字节，让下一轮继续扫描。
         */
        if (this.inFrame) {
          this.pushBytes(data, i, 2);
        }
        i += 2;
        continue;
      }

      /** 普通字节（非 FF） */
      if (this.inFrame) {
        this.pushBytes(data, i, 1);
      }
      i += 1;
    }

    return frames;
  }

  /** 追加一段数据到当前帧 */
  private pushBytes(data: Buffer, start: number, length: number): void {
    this.chunks.push(Buffer.from(data.subarray(start, start + length)));
    this.frameSize += length;
  }
}

/**
 * 帧提取器
 * 通过 ffmpeg 子进程从 RTSP 流中提取 JPEG 帧
 */
export class FrameExtractor {
  /** ffmpeg 子进程 */
  private proc: ReturnType<typeof spawn> | null = null;
  /** JPEG 帧分割器 */
  private splitter = new JpegFrameSplitter();
  /** 是否正在运行 */
  private running = false;
  /** 重连退避计数 */
  private retryCount = 0;
  /** 重连定时器 */
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** 上一次接收到帧的时间 */
  private lastFrameTime = 0;
  /** 当前是否在线（用于检测状态变化） */
  private online = false;

  constructor(
    private config: CameraConfig,
    private ffmpegPath: string,
    private eventBus: EventBus,
  ) {}

  /** 启动帧提取 */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.spawnFfmpeg();
  }

  /** 停止帧提取 */
  stop(): void {
    this.running = false;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.online) {
      this.online = false;
      this.eventBus.emit("camera:offline", { cameraId: this.config.id });
    }
    this.killProcess();
  }

  /** 获取摄像头在线状态 */
  get isOnline(): boolean {
    return this.online;
  }

  /** 获取最近一帧的时间 */
  get lastFrameAt(): number {
    return this.lastFrameTime;
  }

  /** 启动 ffmpeg 子进程 */
  private spawnFfmpeg(): void {
    const { detectFps, detectWidth, jpegQuality, stream } = this.config;

    /** 主码流提供最高清画面 */
    const rtspUrl = stream.hd || stream.sd;
    /** fps 滤镜控制帧率；scale 仅在配置了宽度时才缩放 */
    const vfParts = [`fps=${detectFps}`];
    if (detectWidth > 0) {
      vfParts.push(`scale=${detectWidth}:-4`);
    }
    const vf = vfParts.join(",");

    const args = [
      "-rtsp_transport", "tcp",
      "-i", rtspUrl,
      "-vf", vf,
      "-f", "image2pipe",
      "-vcodec", "mjpeg",
      "-q:v", String(jpegQuality),
      "-an",
      "pipe:1",
    ];

    console.log(`[${this.config.id}] 启动 ffmpeg: ${this.ffmpegPath} ${args.join(" ")}`);

    this.proc = spawn(this.ffmpegPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdout = this.proc.stdout;
    const stderr = this.proc.stderr;

    if (stdout) {
      stdout.on("data", (chunk: Buffer) => {
        const frames = this.splitter.feed(chunk);
        for (const frame of frames) {
          const now = Date.now();
          this.lastFrameTime = now;
          this.retryCount = 0;
          if (!this.online) {
            this.online = true;
            this.eventBus.emit("camera:online", { cameraId: this.config.id });
            console.log(`[${this.config.id}] 摄像头上线`);
          }
          this.eventBus.emit("frame", {
            cameraId: this.config.id,
            data: frame,
            timestamp: now,
          });
        }
      });
    }

    if (stderr) {
      stderr.on("data", (chunk: Buffer) => {
        const msg = chunk.toString().trim();
        /** 只打印关键错误，不打印 ffmpeg 的大量 info 日志 */
        if (msg.includes("error") || msg.includes("Error")) {
          console.error(`[${this.config.id}] ffmpeg stderr:`, msg);
        }
      });
    }

    this.proc.on("exit", (code: number | null) => {
      console.log(`[${this.config.id}] ffmpeg 进程退出, code=${code}`);
      this.proc?.unref();
      this.proc = null;
      if (this.online) {
        this.online = false;
        this.eventBus.emit("camera:offline", { cameraId: this.config.id });
        console.log(`[${this.config.id}] 摄像头离线`);
      }
      if (this.running) {
        this.scheduleReconnect();
      }
    });

    this.proc.on("error", (err: Error) => {
      console.error(`[${this.config.id}] ffmpeg 进程错误:`, err.message);
    });
  }

  /** 计划重连（指数退避） */
  private scheduleReconnect(): void {
    this.retryCount++;
    /** 指数退避：2s, 4s, 8s, ... 最大 60s */
    const delay = Math.min(2000 * Math.pow(2, this.retryCount - 1), 60_000);
    console.log(`[${this.config.id}] ${delay}ms 后重连... (第 ${this.retryCount} 次)`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.spawnFfmpeg();
    }, delay);
  }

  /** 杀死 ffmpeg 进程并清理管道 */
  private killProcess(): void {
    if (this.proc) {
      const proc = this.proc;
      this.proc = null;
      /** 先关闭管道，避免阻塞 */
      proc.stdout?.destroy();
      proc.stderr?.destroy();
      proc.kill("SIGKILL");
      proc.unref();
    }
  }
}
