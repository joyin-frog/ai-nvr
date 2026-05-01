import { spawn } from "node:child_process";
import { type CameraConfig } from "@/config";
import { type EventBus } from "@/event-bus";

/** JPEG 帧起始标记 */
const JPEG_START = 0xff;
const JPEG_SOI = 0xd8;
const JPEG_EOI = 0xd9;

/** JPEG SOI 标记字节序列 */
const SOI = Buffer.from([JPEG_START, JPEG_SOI]);
/** JPEG EOI 标记字节序列 */
const EOI = Buffer.from([JPEG_START, JPEG_EOI]);

/**
 * 从 ffmpeg stdout 的 MJPEG 字节流中分割出独立的 JPEG 帧
 * 使用 indexOf 快速搜索标记，避免逐字节扫描
 */
class JpegFrameSplitter {
  /** 当前帧数据（从 SOI 到当前位置） */
  private frameChunks: Buffer[] = [];
  /** 当前帧总字节数 */
  private frameSize = 0;
  /** 是否在帧内（已遇到 SOI） */
  private inFrame = false;

  /** 处理一块数据，返回完整帧列表 */
  feed(data: Buffer): Buffer[] {
    const frames: Buffer[] = [];

    if (!this.inFrame) {
      /** 帧外：搜索 SOI (FF D8) */
      const soiPos = data.indexOf(SOI);
      if (soiPos === -1) return frames;

      this.inFrame = true;
      this.frameChunks = [];
      this.frameSize = 0;

      /** SOI 开始的数据 */
      const rest = data.subarray(soiPos);
      return this.scanForEoi(rest, frames);
    }

    /** 帧内：搜索 EOI (FF D9) */
    return this.scanForEoi(data, frames);
  }

  /** 在数据中搜索 EOI，提取完整帧 */
  private scanForEoi(data: Buffer, frames: Buffer[]): Buffer[] {
    const eoiPos = data.indexOf(EOI);
    if (eoiPos === -1) {
      /** 没有 EOI，整块数据属于当前帧 */
      this.frameChunks.push(data);
      this.frameSize += data.length;
      return frames;
    }

    /** 找到 EOI：当前帧从开始到 EOI + 2 */
    const frameEnd = eoiPos + 2;
    this.frameChunks.push(data.subarray(0, frameEnd));
    this.frameSize += frameEnd;

    const frame = Buffer.concat(this.frameChunks, this.frameSize);
    frames.push(frame);

    /** 重置帧状态 */
    this.frameChunks = [];
    this.frameSize = 0;
    this.inFrame = false;

    /** 处理 EOI 之后的数据 */
    const rest = data.subarray(frameEnd);
    if (rest.length > 0) {
      return this.feed(rest);
    }
    return frames;
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
    const vfParts: string[] = [];
    if (detectFps > 0) {
      vfParts.push(`fps=${detectFps}`);
    }
    if (detectWidth > 0) {
      vfParts.push(`scale=${detectWidth}:-4`);
    }
    const vf = vfParts.length > 0 ? vfParts.join(",") : undefined;

    const args: string[] = [
      "-rtsp_transport", "tcp",
      /** 低延迟：减少缓冲和探测时间 */
      "-fflags", "nobuffer",
      "-flags", "low_delay",
      "-analyzeduration", "1000000",
      "-probesize", "500000",
      "-i", rtspUrl,
    ];
    if (vf) {
      args.push("-vf", vf);
    }
    args.push(
      "-f", "image2pipe",
      "-vcodec", "mjpeg",
      "-q:v", String(jpegQuality),
      "-an",
      /** 线程数：利用多核加速 HEVC 解码 + MJPEG 编码 */
      "-threads", "4",
      "pipe:1",
    );

    console.log(`[${this.config.id}] 启动 ffmpeg: ${this.ffmpegPath} ${args.join(" ")}`);

    this.proc = spawn(this.ffmpegPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdout = this.proc.stdout!;
    const stderr = this.proc.stderr!;

    if (stdout) {
      let frameCount = 0;
      let lastPerfLog = Date.now();
      let totalFrameBytes = 0;
      stdout.on("data", (chunk: Buffer) => {
        const t0 = performance.now();
        const frames = this.splitter.feed(chunk);
        const splitMs = performance.now() - t0;
        for (const frame of frames) {
          const now = Date.now();
          this.lastFrameTime = now;
          this.retryCount = 0;
          totalFrameBytes += frame.length;
          frameCount++;
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
          /** 每 10 秒输出性能日志 */
          if (now - lastPerfLog >= 10000) {
            const avgSize = totalFrameBytes / frameCount;
            console.log(`[Perf][${this.config.id}] ${frameCount}帧/10s, avg ${(avgSize / 1024).toFixed(0)}KB/帧, split=${splitMs.toFixed(1)}ms`);
            frameCount = 0;
            totalFrameBytes = 0;
            lastPerfLog = now;
          }
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

    this.proc!.on("exit", (code: number | null) => {
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

    this.proc!.on("error", (err: Error) => {
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
