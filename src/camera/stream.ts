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
  /** 单帧最大字节数（超过则丢弃当前帧，防止损坏流导致 OOM） */
  private static readonly MAX_FRAME_SIZE = 20 * 1024 * 1024; // 20MB

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
    /** 帧大小保护：超过上限说明流已损坏，丢弃当前帧重新同步 */
    if (this.frameSize + data.length > JpegFrameSplitter.MAX_FRAME_SIZE) {
      this.frameChunks = [];
      this.frameSize = 0;
      this.inFrame = false;
      /** 在当前数据块中重新搜索 SOI */
      return this.feed(data);
    }

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

/** 帧提取器用途 */
export type StreamPurpose = "display" | "detect";

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
  /** 日志标签 */
  private logTag: string;
  /** 帧率统计：最近 5 秒的帧数 */
  private fpsFrameCount = 0;
  /** 帧率统计：上次统计时间 */
  private fpsLastTime = 0;
  /** 当前实际帧率（5秒滑动窗口） */
  private currentFps = 0;

  constructor(
    private config: CameraConfig,
    private ffmpegPath: string,
    private eventBus: EventBus,
    private purpose: StreamPurpose = "detect",
    private rtspOverride?: string,
    private fpsOverride?: number,
    private widthOverride?: number,
  ) {
    this.logTag = purpose === "display"
      ? `[Display][${config.id}]`
      : `[Detect][${config.id}]`;
  }

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
    /** 只有显示流负责在线状态事件 */
    if (this.online && this.purpose === "display") {
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

  /** 获取当前实际帧率（5秒滑动窗口） */
  get fps(): number {
    return this.currentFps;
  }

  /** 启动 ffmpeg 子进程 */
  private spawnFfmpeg(): void {
    const { detectWidth, jpegQuality, stream } = this.config;
    /** 显示流使用更高质量（更小的 q 值），检测流保持默认 */
    const effectiveQuality = this.purpose === "display" ? Math.min(jpegQuality, 5) : jpegQuality;

    /** 显示流用 HD，检测流用 SD（fallback 到 HD） */
    const rtspUrl = this.rtspOverride ?? (stream.hd || stream.sd);
    const fps = this.fpsOverride ?? this.config.detectFps;
    const width = this.widthOverride ?? detectWidth;

    const vfParts: string[] = [];
    if (fps > 0 && this.purpose === "detect" && this.rtspOverride) {
      /** 双流模式的检测流限制帧率；单流模式不限制 fps，由 AI detector interval 控制 */
      vfParts.push(`fps=${fps}:round=zero`);
    }
    if (width > 0) {
      vfParts.push(`scale=${width}:-4`);
    }
    const vf = vfParts.length > 0 ? vfParts.join(",") : undefined;

    const args: string[] = [
      "-rtsp_transport", "tcp",
      /** 低延迟：减少缓冲和探测时间 */
      "-fflags", "nobuffer",
      "-flags", "low_delay",
      "-max_delay", "0",
      "-reorder_queue_size", "0",
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
      "-q:v", String(effectiveQuality),
      "-an",
      /** 线程数：利用多核加速 HEVC 解码 + MJPEG 编码 */
      "-threads", "4",
      "pipe:1",
    );

    console.log(`${this.logTag} 启动 ffmpeg: ${this.ffmpegPath} ${args.join(" ")}`);

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
            /** 只有显示流触发在线/离线事件 */
            if (this.purpose === "display") {
              this.eventBus.emit("camera:online", { cameraId: this.config.id });
              console.log(`${this.logTag} 摄像头上线`);
            }
          }
          /** 显示流发 frame 事件，检测流发 detect:frame 事件 */
          /** 单流模式（默认 purpose=detect）同时发两个事件，兼容所有消费者 */
          const payload = {
            cameraId: this.config.id,
            data: frame,
            timestamp: now,
          };
          if (this.purpose === "display") {
            this.eventBus.emit("frame", payload);
            this.eventBus.emit("detect:frame", payload);
          } else if (this.purpose === "detect" && this.rtspOverride) {
            /** 双流模式的检测流只发 detect:frame */
            this.eventBus.emit("detect:frame", payload);
          } else {
            /** 单流模式：同时发 frame（显示/录像）和 detect:frame（AI/变动检测） */
            this.eventBus.emit("frame", payload);
            this.eventBus.emit("detect:frame", payload);
          }
          /** 每 10 秒输出性能日志 */
          /** 帧率统计：5秒滑动窗口 */
          this.fpsFrameCount++;
          if (now - this.fpsLastTime >= 5000) {
            this.currentFps = this.fpsFrameCount / ((now - this.fpsLastTime) / 1000);
            this.fpsFrameCount = 0;
            this.fpsLastTime = now;
          }
          if (now - lastPerfLog >= 10000) {
            const avgSize = totalFrameBytes / frameCount;
            console.log(`[Perf]${this.logTag} ${frameCount}帧/10s, avg ${(avgSize / 1024).toFixed(0)}KB/帧, split=${splitMs.toFixed(1)}ms`);
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
        if (msg.includes("error") || msg.includes("Error")) {
          console.error(`${this.logTag} ffmpeg stderr:`, msg);
        }
      });
    }

    this.proc!.on("exit", (code: number | null) => {
      console.log(`${this.logTag} ffmpeg 进程退出, code=${code}`);
      this.proc?.unref();
      this.proc = null;
      if (this.online) {
        this.online = false;
        if (this.purpose === "display") {
          this.eventBus.emit("camera:offline", { cameraId: this.config.id });
          console.log(`${this.logTag} 摄像头离线`);
        }
      }
      if (this.running) {
        this.scheduleReconnect();
      }
    });

    this.proc!.on("error", (err: Error) => {
      console.error(`${this.logTag} ffmpeg 进程错误:`, err.message);
    });
  }

  /** 计划重连（指数退避，超过阈值后降频） */
  private scheduleReconnect(): void {
    this.retryCount++;
    /** 超过 10 次后降频为每 5 分钟检查一次 */
    const maxRetries = 10;
    let delay: number;
    if (this.retryCount > maxRetries) {
      delay = 300_000;
      if (this.retryCount === maxRetries + 1) {
        console.warn(`${this.logTag} 连续 ${maxRetries} 次重连失败，降频为每 5 分钟检查一次`);
      }
    } else {
      delay = Math.min(2000 * Math.pow(2, this.retryCount - 1), 60_000);
    }
    console.log(`${this.logTag} ${delay}ms 后重连... (第 ${this.retryCount} 次)`);
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
      proc.stdout?.destroy();
      proc.stderr?.destroy();
      proc.kill("SIGKILL");
      proc.unref();
    }
  }
}
