import { spawn } from "node:child_process";
import { Readable } from "node:stream";
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
export class JpegFrameSplitter {
  private frameChunks: Buffer[] = [];
  private frameSize = 0;
  private inFrame = false;
  /** 单帧最大字节数（超过则丢弃当前帧，防止损坏流导致 OOM） */
  private static readonly MAX_FRAME_SIZE = 20 * 1024 * 1024;

  /** 处理一块数据，返回完整帧列表 */
  feed(data: Buffer): Buffer[] {
    const frames: Buffer[] = [];

    if (!this.inFrame) {
      const soiPos = data.indexOf(SOI);
      if (soiPos === -1) return frames;

      this.inFrame = true;
      this.frameChunks = [];
      this.frameSize = 0;

      const rest = data.subarray(soiPos);
      return this.scanForEoi(rest, frames);
    }

    return this.scanForEoi(data, frames);
  }

  private scanForEoi(data: Buffer, frames: Buffer[]): Buffer[] {
    if (this.frameSize + data.length > JpegFrameSplitter.MAX_FRAME_SIZE) {
      this.frameChunks = [];
      this.frameSize = 0;
      this.inFrame = false;
      return this.feed(data);
    }

    const eoiPos = data.indexOf(EOI);
    if (eoiPos === -1) {
      this.frameChunks.push(data);
      this.frameSize += data.length;
      return frames;
    }

    const frameEnd = eoiPos + 2;
    this.frameChunks.push(data.subarray(0, frameEnd));
    this.frameSize += frameEnd;

    /** 独立拷贝：切断对 ffmpeg stdout chunk 的 ArrayBuffer 引用，避免阻止 GC */
    const frame = this.frameChunks.length === 1
      ? Buffer.from(this.frameChunks[0]!)
      : Buffer.concat(this.frameChunks, this.frameSize);
    frames.push(frame);

    this.frameChunks = [];
    this.frameSize = 0;
    this.inFrame = false;

    const rest = data.subarray(frameEnd);
    if (rest.length > 0) {
      return this.feed(rest);
    }
    return frames;
  }
}

/**
 * JPEG 抽帧器
 * 从 HD RTSP 流中低帧率提取 JPEG 帧，专用于：
 * - AI 检测（detect:frame 事件）
 * - Motion 变动检测（detect:frame 事件）
 * - MJPEG SSE 回退（frame 事件）
 * - CameraManager latestFrames 缓存（frame 事件）
 *
 * 与旧 FrameExtractor 的区别：
 * - 始终使用 HD 流（高分辨率源）
 * - 低帧率（由 detectFps 控制）
 * - 可选降分辨率（由 detectWidth 控制）
 * - 同时发 frame + detect:frame 事件
 */
export class JpegExtractor {
  private proc: ReturnType<typeof spawn> | null = null;
  private splitter = new JpegFrameSplitter();
  private running = false;
  private online = false;
  private retryCount = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private lastFrameTime = 0;
  private static readonly WATCHDOG_TIMEOUT = 5_000;
  private logTag: string;
  /** 帧率统计 */
  private fpsFrameCount = 0;
  private fpsLastTime = 0;
  private currentFps = 0;
  /** 复用的帧 payload 对象 */
  private reusablePayload: { cameraId: string; data: Buffer; timestamp: number };

  constructor(
    private config: CameraConfig,
    private ffmpegPath: string,
    private eventBus: EventBus,
  ) {
    this.logTag = `[JPEG][${config.id}]`;
    this.reusablePayload = { cameraId: config.id, data: Buffer.alloc(0), timestamp: 0 };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.spawnFfmpeg();
  }

  stop(): void {
    this.running = false;
    this.clearWatchdog();
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.online) {
      this.online = false;
      this.eventBus.emit("extractor:offline", { cameraId: this.config.id, source: "frame" });
    }
    this.killProcess();
  }

  get isOnline(): boolean {
    return this.online;
  }

  get lastFrameAt(): number {
    return this.lastFrameTime;
  }

  get fps(): number {
    return this.currentFps;
  }

  private spawnFfmpeg(): void {
    const rtspUrl = this.config.stream.hd || this.config.stream.sd;
    const fps = this.config.detectFps || 5;
    const width = this.config.detectWidth;
    const jpegQuality = Math.min(this.config.jpegQuality, 10);

    const vfParts: string[] = [];
    if (fps > 0) {
      vfParts.push(`fps=${fps}:round=zero`);
    }
    if (width > 0) {
      vfParts.push(`scale=${width}:-4`);
    }
    const vf = vfParts.length > 0 ? vfParts.join(",") : undefined;

    const args: string[] = [
      "-rtsp_transport", "tcp",
      "-avioflags", "direct",
      "-fflags", "nobuffer+fastseek+genpts+discardcorrupt",
      "-flags", "low_delay",
      "-max_delay", "0",
      "-reorder_queue_size", "0",
      "-thread_queue_size", "1",
      "-analyzeduration", "100000",
      "-probesize", "32768",
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
      "-threads", "2",
      "pipe:1",
    );

    console.log(`${this.logTag} 启动 ffmpeg: ${this.ffmpegPath} ${args.join(" ")}`);

    this.proc = spawn(this.ffmpegPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdout = this.proc.stdout ? new Readable({ highWaterMark: 4096 }).wrap(this.proc.stdout) : null;

    if (stdout) {
      let frameCount = 0;
      let lastPerfLog = Date.now();
      let totalFrameBytes = 0;
      stdout.on("data", (chunk: Buffer) => {
        const frames = this.splitter.feed(chunk);
        for (const frame of frames) {
          const now = Date.now();
          this.lastFrameTime = now;
          this.retryCount = 0;
          this.resetWatchdog();
          totalFrameBytes += frame.length;
          frameCount++;
          if (!this.online) {
            this.online = true;
            this.eventBus.emit("extractor:online", { cameraId: this.config.id, source: "frame" });
            console.log(`${this.logTag} 摄像头上线`);
          }
          const payload = this.reusablePayload;
          payload.data = frame;
          payload.timestamp = now;
          this.eventBus.emit("detect:frame", payload);
          this.eventBus.emit("frame", payload);

          this.fpsFrameCount++;
          if (now - this.fpsLastTime >= 5000) {
            this.currentFps = this.fpsFrameCount / ((now - this.fpsLastTime) / 1000);
            this.fpsFrameCount = 0;
            this.fpsLastTime = now;
          }
          if (now - lastPerfLog >= 10000) {
            const avgSize = totalFrameBytes / frameCount;
            console.log(`[Perf]${this.logTag} ${frameCount}帧/10s, avg ${(avgSize / 1024).toFixed(0)}KB/帧`);
            frameCount = 0;
            totalFrameBytes = 0;
            lastPerfLog = now;
          }
        }
      });
    }

    this.proc.stderr?.on("data", (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg.includes("error") || msg.includes("Error")) {
        console.error(`${this.logTag} ffmpeg stderr:`, msg);
      }
    });

    this.proc.on("exit", (code: number | null) => {
      console.log(`${this.logTag} ffmpeg 进程退出, code=${code}`);
      this.clearWatchdog();
      this.proc?.unref();
      this.proc = null;
      if (this.online) {
        this.online = false;
        this.eventBus.emit("extractor:offline", { cameraId: this.config.id, source: "frame" });
        console.log(`${this.logTag} 摄像头离线`);
      }
      if (this.running) {
        this.scheduleReconnect();
      }
    });

    this.proc.on("error", (err: Error) => {
      console.error(`${this.logTag} ffmpeg 进程错误:`, err.message);
    });

    this.resetWatchdog();
  }

  private resetWatchdog(): void {
    this.lastFrameTime = Date.now();
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(() => {
      if (!this.proc) { this.clearWatchdog(); return; }
      if (Date.now() - this.lastFrameTime > JpegExtractor.WATCHDOG_TIMEOUT) {
        console.warn(`${this.logTag} ffmpeg ${JpegExtractor.WATCHDOG_TIMEOUT / 1000}s 无帧输出，可能卡死，强制重启`);
        this.killProcess();
      }
    }, 1000);
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private scheduleReconnect(): void {
    this.retryCount++;
    const maxRetries = 10;
    let delay: number;
    if (this.retryCount > maxRetries) {
      delay = 300_000;
      if (this.retryCount === maxRetries + 1) {
        console.warn(`${this.logTag} 连续 ${maxRetries} 次重连失败，降频为每 5 分钟检查一次`);
      }
    } else {
      delay = Math.min(200 * Math.pow(2, this.retryCount - 1), 60_000);
    }
    console.log(`${this.logTag} ${delay}ms 后重连... (第 ${this.retryCount} 次)`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.spawnFfmpeg();
    }, delay);
  }

  private killProcess(): void {
    if (this.proc) {
      const proc = this.proc;
      this.proc = null;
      proc.stdout?.destroy();
      proc.stderr?.destroy();
      proc.kill("SIGKILL");
      proc.unref();
    }
  }
}
