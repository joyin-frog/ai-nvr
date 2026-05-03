import { type EventBus } from "@/event-bus";
import { type CameraConfig } from "@/config";
import { type RuntimeConfig } from "@/runtime-config";
import { execFile, spawn } from "node:child_process";
import { Readable } from "node:stream";
import { JpegFrameSplitter } from "./jpeg-extractor";

/** 硬件编码器探测结果缓存（进程级，只探测一次） */
let cachedEncoder: string | null = null;
/** 探测是否正在进行 */
let probePromise: Promise<string> | null = null;

/** 异步探测可用的硬件编码器，返回优先级最高的可用编码器名称 */
function probeHardwareEncoder(ffmpegPath: string, vaapiDevice: string): Promise<string> {
  if (cachedEncoder !== null) return Promise.resolve(cachedEncoder);
  /** 复用正在进行的探测，避免并发启动多个 ffmpeg 进程 */
  if (probePromise) return probePromise;

  probePromise = (async () => {
    const candidates = [
      { name: "h264_nvenc", args: ["-f", "lavfi", "-i", "color=black:s=64x64:d=0.1", "-c:v", "h264_nvenc", "-f", "null", "-"] },
      { name: "h264_vaapi", args: ["-f", "lavfi", "-i", "color=black:s=64x64:d=0.1", "-vaapi_device", vaapiDevice, "-c:v", "h264_vaapi", "-f", "null", "-"] },
      { name: "h264_qsv", args: ["-f", "lavfi", "-i", "color=black:s=64x64:d=0.1", "-c:v", "h264_qsv", "-f", "null", "-"] },
      { name: "h264_videotoolbox", args: ["-f", "lavfi", "-i", "color=black:s=64x64:d=0.1", "-c:v", "h264_videotoolbox", "-f", "null", "-"] },
      { name: "h264_amf", args: ["-f", "lavfi", "-i", "color=black:s=64x64:d=0.1", "-c:v", "h264_amf", "-f", "null", "-"] },
    ];

    for (const candidate of candidates) {
      const ok = await new Promise<boolean>((resolve) => {
        const proc = execFile(ffmpegPath, candidate.args, { timeout: 5000 }, (err) => {
          resolve(!err);
        });
        proc.unref();
      });
      if (ok) {
        cachedEncoder = candidate.name;
        console.log(`[Encoder] 硬件编码器探测成功: ${candidate.name}`);
        probePromise = null;
        return cachedEncoder;
      }
    }

    cachedEncoder = "libx264";
    console.log("[Encoder] 无可用硬件编码器，回退到 libx264 软编码");
    probePromise = null;
    return cachedEncoder;
  })();

  return probePromise;
}

/** fMP4 段类型 */
export interface Fmp4InitSegment {
  type: "init";
  codec: string;
  data: Buffer;
}

export interface Fmp4MediaSegment {
  type: "media";
  /** 零拷贝引用：moof box 数据 */
  moofData: Buffer;
  /** 零拷贝引用：mdat box 数据 */
  mdatData: Buffer;
}

export type Fmp4Segment = Fmp4InitSegment | Fmp4MediaSegment;

/**
 * ffmpeg fMP4 流解析器
 * 解析 ffmpeg 输出的 fMP4 二进制流，拆分为 init/media segment
 * ffmpeg 使用 `-f mp4 -movflags frag_keyframe+empty_moov+default_base_moof` 输出标准 fMP4
 */
/** O(1) 快速拼接两个 Buffer（避免 Buffer.concat 对 2 元素数组的迭代开销） */
function concat2(a: Buffer, b: Buffer): Buffer {
  const result = Buffer.allocUnsafe(a.length + b.length);
  a.copy(result, 0);
  b.copy(result, a.length);
  return result;
}

class Fmp4StreamParser {
  /** 已解析出的完整 box 列表（等待组装为 segment） */
  private completedBoxes: Array<{ type: string; data: Buffer }> = [];
  /** media segment 中是否已收集到 moof（标志位替代 Array.some） */
  private hasMoof = false;
  /** 是否已收集到 init segment (ftyp + moov) */
  private initCollected = false;
  /** 缓存的 init segment */
  private cachedInit: Fmp4InitSegment | null = null;
  /** 最近一个 media segment 的组成部分（零拷贝引用，按需合并） */
  private lastMoof: Buffer | null = null;
  private lastMdat: Buffer | null = null;
  /** 缓存的合并结果（被 lastMediaSegment getter 消费后清除） */
  private lastMergedMedia: Buffer | null = null;
  /** 帧率统计 */
  private segmentCount = 0;
  private segmentCountStart = Date.now();
  private currentFps = 0;
  /** 视频宽度 */
  private width = 0;
  /** 视频高度 */
  private height = 0;
  /** 从 moov 中提取的 codec */
  private codec = "avc1.42C01E";
  /** 已物化的连续 buffer */
  private buffer: Buffer = Buffer.allocUnsafe(0);
  /** 待合并的 chunks（延迟 flatten 减少 GC） */
  private pendingChunks: Buffer[] = [];

  feed(data: Buffer, eventBus: EventBus, cameraId: string): void {
    if (this.pendingChunks.length === 0 && this.buffer.length === 0) {
      this.buffer = data;
    } else {
      this.pendingChunks.push(data);
    }
    this.parseBoxes(eventBus, cameraId);
  }

  get fps(): number { return this.currentFps; }

  get lastInitSegment(): Fmp4InitSegment | null { return this.cachedInit; }

  get videoWidth(): number { return this.width; }
  get videoHeight(): number { return this.height; }

  /** 获取缓存的最近 media segment（新客户端首帧，按需合并） */
  get lastMediaSegment(): Buffer | null {
    if (this.lastMergedMedia) return this.lastMergedMedia;
    if (this.lastMoof && this.lastMdat) {
      this.lastMergedMedia = concat2(this.lastMoof, this.lastMdat);
      return this.lastMergedMedia;
    }
    return null;
  }

  reset(): void {
    this.buffer = Buffer.allocUnsafe(0);
    this.pendingChunks = [];
    this.completedBoxes = [];
    this.initCollected = false;
    this.segmentCount = 0;
    this.segmentCountStart = Date.now();
    this.currentFps = 0;
    this.cachedInit = null;
    this.lastMoof = null;
    this.lastMdat = null;
    this.lastMergedMedia = null;
  }

  /** 将 pending chunks 合并到 buffer（使用 concat2 避免数组展开） */
  private flattenIfNeeded(): void {
    const n = this.pendingChunks.length;
    if (n === 0) return;
    if (n === 1 && this.buffer.length === 0) {
      this.buffer = this.pendingChunks[0]!;
    } else if (n === 1) {
      this.buffer = concat2(this.buffer, this.pendingChunks[0]!);
    } else {
      this.buffer = Buffer.concat([this.buffer, ...this.pendingChunks]);
    }
    this.pendingChunks = [];
  }

  /** 解析 ISO BMFF boxes */
  private parseBoxes(eventBus: EventBus, cameraId: string): void {
    this.flattenIfNeeded();
    let buf = this.buffer;
    let offset = 0;

    while (offset < buf.length) {
      if (buf.length - offset < 8) break;

      const boxSize = buf.readUInt32BE(offset);
      const boxType = buf.subarray(offset + 4, offset + 8).toString("ascii");

      const actualSize = boxSize === 0 ? buf.length - offset : boxSize;

      if (boxSize === 1) {
        if (buf.length - offset < 16) break;
        const extSize = Number(buf.readBigUInt64BE(offset + 8));
        if (buf.length - offset < extSize) break;
        this.handleBox(boxType, buf.subarray(offset, offset + extSize), eventBus, cameraId);
        offset += extSize;
        continue;
      }

      if (actualSize < 8 || buf.length - offset < actualSize) break;

      this.handleBox(boxType, buf.subarray(offset, offset + actualSize), eventBus, cameraId);
      offset += actualSize;
    }

    /** 当消费了超过 64KB 数据时执行一次拷贝截断，避免 subarray 保留对大 buffer 的引用导致内存无法释放 */
    if (offset > 0) {
      this.buffer = (buf.length - offset < 65536 && offset > 65536)
        ? Buffer.from(buf.subarray(offset))
        : buf.subarray(offset);
    } else {
      this.buffer = buf;
    }
  }

  /** 处理一个完整 box */
  private handleBox(type: string, data: Buffer, eventBus: EventBus, cameraId: string): void {
    if (!this.initCollected) {
      /** 收集 init segment: ftyp + moov */
      this.completedBoxes.push({ type, data });

      if (type === "moov") {
        /** 从 moov 中提取 codec 和分辨率 */
        this.extractCodecFromMoov(data);
        this.extractDimensionsFromMoov(data);

        /** 组装 init segment: ftyp + moov（恰好 2 个 box，避免 Buffer.concat 开销） */
        const initData = concat2(this.completedBoxes[0]!.data, this.completedBoxes[1]!.data);
        const init: Fmp4InitSegment = {
          type: "init",
          codec: this.codec,
          data: initData,
        };
        this.cachedInit = init;
        eventBus.emit("fmp4:init", { cameraId, segment: init });
        this.initCollected = true;
        this.completedBoxes.length = 0;
      }
    } else {
      /** 收集 media segment: moof + mdat */
      this.completedBoxes.push({ type, data });
      if (type === "moof") this.hasMoof = true;

      /** moof 后面跟的 mdat 组成一个完整的 media segment */
      if (type === "mdat" && this.hasMoof) {
        const moofData = this.completedBoxes[0]!.data;
        const mdatData = this.completedBoxes[1]!.data;

        /** 缓存零拷贝引用，lastMediaSegment getter 按需合并（消除每帧 alloc+copy） */
        this.lastMoof = moofData;
        this.lastMdat = mdatData;
        this.lastMergedMedia = null;

        eventBus.emit("fmp4:segment", { cameraId, moofData, mdatData });
        this.completedBoxes.length = 0;
        this.hasMoof = false;

        /** FPS 统计 */
        this.segmentCount++;
        const now = Date.now();
        if (now - this.segmentCountStart >= 5000) {
          this.currentFps = this.segmentCount * 1000 / (now - this.segmentCountStart);
          this.segmentCount = 0;
          this.segmentCountStart = now;
        }
      }
    }
  }

  /** 从 moov 中提取 codec 字符串 */
  private extractCodecFromMoov(moov: Buffer): void {
    /** 递归搜索 stsd box 中的 avc1/hvc1 sample entry */
    const codec = this.findCodecInBox(moov, 8);
    if (codec) {
      this.codec = codec;
    }
  }

  /** 递归搜索 box 中的 codec 信息 */
  private findCodecInBox(data: Buffer, start: number): string | null {
    let offset = start;
    while (offset + 8 <= data.length) {
      const size = data.readUInt32BE(offset);
      const type = data.subarray(offset + 4, offset + 8).toString("ascii");

      if (size < 8 || offset + size > data.length) break;

      if (type === "avc1" || type === "hvc1") {
        /** sample entry 结构: [6B reserved][2B data_ref_idx][...][2B width @ +32][2B height @ +34] */
        const boxPayload = data.subarray(offset + 8, offset + size);
        if (type === "avc1") {
          /** 搜索 avcC 子 box */
          const avcC = this.findSubBox(boxPayload, "avcC");
          if (avcC && avcC.length > 7) {
            const profile = avcC[1]!;
            const compat = avcC[2]!;
            const level = avcC[3]!;
            return `avc1.${profile.toString(16).padStart(2, "0")}${compat.toString(16).padStart(2, "0")}${level.toString(16).padStart(2, "0")}`;
          }
          return "avc1.42C01E";
        }
        /** hvc1 */
        const hvcC = this.findSubBox(boxPayload, "hvcC");
        if (hvcC && hvcC.length > 21) {
          const profileIdc = hvcC[1]! & 0x1f;
          const levelIdc = hvcC[12]!;
          return `hvc1.${profileIdc}.L${levelIdc}.B0`;
        }
        return "hvc1.1.6.L93.B0";
      }

      /** 递归搜索容器 box */
      const isContainer = type === "moov" || type === "trak" || type === "mdia" || type === "minf" || type === "stbl" || type === "stsd";
      if (isContainer) {
        /** stsd 是 fullbox: version(1B) + flags(3B) + entry_count(4B) = 8 字节额外偏移 */
        const childStart = offset + 8 + (type === "stsd" ? 8 : 0);
        const result = this.findCodecInBox(data, childStart);
        if (result) return result;
      }

      offset += size;
    }
    return null;
  }

  /** 在 sample entry payload 中搜索子 box */
  private findSubBox(payload: Buffer, target: string): Buffer | null {
    /** sample entry 头部: 6B reserved + 2B data_ref_idx + 2B pre_defined + 2B reserved
     * + 12B pre_defined + 2B width + 2B height + 4B horiz_res + 4B vert_res + 4B reserved
     * + 2B frame_count + 32B compressor + 2B depth + 2B pre_defined = 78 bytes
     * 子 box 从 offset 78 开始 */
    let offset = 78;
    while (offset + 8 <= payload.length) {
      const size = payload.readUInt32BE(offset);
      const type = payload.subarray(offset + 4, offset + 8).toString("ascii");
      if (size < 8 || offset + size > payload.length) break;
      if (type === target) {
        return payload.subarray(offset + 8, offset + size);
      }
      offset += size;
    }
    return null;
  }

  /** 从 moov 中提取视频分辨率 */
  private extractDimensionsFromMoov(moov: Buffer): void {
    const result = this.findDimensionsInBox(moov, 8);
    if (result) {
      this.width = result.width;
      this.height = result.height;
    }
  }

  private findDimensionsInBox(data: Buffer, start: number): { width: number; height: number } | null {
    let offset = start;
    while (offset + 8 <= data.length) {
      const size = data.readUInt32BE(offset);
      const type = data.subarray(offset + 4, offset + 8).toString("ascii");
      if (size < 8 || offset + size > data.length) break;

      if (type === "avc1" || type === "hvc1") {
        /** width 在 box payload offset 24-25, height 在 26-27 (0-indexed from payload start) */
        const payload = data.subarray(offset + 8, offset + size);
        if (payload.length >= 28) {
          return {
            width: payload.readUInt16BE(24),
            height: payload.readUInt16BE(26),
          };
        }
      }

      if (type === "moov" || type === "trak" || type === "mdia" || type === "minf" || type === "stbl" || type === "stsd") {
        /** stsd 是 fullbox: version(1B) + flags(3B) + entry_count(4B) = 8 字节 */
        const childStart = offset + 8 + (type === "stsd" ? 8 : 0);
        const result = this.findDimensionsInBox(data, childStart);
        if (result) return result;
      }

      offset += size;
    }
    return null;
  }
}

/**
 * 视频 RTSP → fMP4 流提取器
 * 使用 ffmpeg 直接输出 fMP4 格式，后端解析 box 边界后转发
 * ffmpeg 生成的 fMP4 结构完全标准，浏览器 MSE 兼容性好
 */
export class H264Fmp4Extractor {
  private proc: ReturnType<typeof spawn> | null = null;
  private parser = new Fmp4StreamParser();
  private running = false;
  private online = false;
  /** 看门狗超时阈值（毫秒） */
  private static readonly WATCHDOG_TIMEOUT = 3_000;
  private retryCount = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** 看门狗：检测 ffmpeg 卡死（无数据输出） */
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private logTag: string;
  /** 缓存 init segment（新客户端连接时发送） */
  private cachedInit: Fmp4InitSegment | null = null;
  /** JPEG 解码子进程 */
  private jpegProc: ReturnType<typeof spawn> | null = null;
  private jpegSplitter = new JpegFrameSplitter();
  /** 复用的帧 payload */
  private reusablePayload: { cameraId: string; data: Buffer; timestamp: number };

  constructor(
    private config: CameraConfig,
    private ffmpegPath: string,
    private eventBus: EventBus,
    private rtspUrl: string,
    private runtimeConfig?: RuntimeConfig,
  ) {
    this.logTag = `[Video-fMP4][${config.id}]`;
    this.reusablePayload = { cameraId: config.id, data: Buffer.alloc(0), timestamp: 0 };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.spawnFfmpeg();
    this.spawnJpegDecoder();
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
      this.eventBus.emit("extractor:offline", { cameraId: this.config.id, source: "fmp4" });
    }
    this.killJpegProc();
    this.killProcess();
  }

  get isOnline(): boolean { return this.online; }

  get fps(): number { return this.parser.fps; }

  get initSegment(): Fmp4InitSegment | null { return this.cachedInit; }

  /** 获取缓存的最近 media segment（新客户端连接时立即显示画面） */
  get lastMediaSegment(): Buffer | null { return this.parser.lastMediaSegment; }

  get lastFrameAt(): number { return this.online ? Date.now() : 0; }

  /** 视频分辨率（从 moov 解析） */
  get videoWidth(): number { return this.parser.videoWidth; }
  get videoHeight(): number { return this.parser.videoHeight; }

  /** codec 类型（固定返回 avc，因为 ffmpeg 输出 h264） */
  get detectedCodec(): "avc" | null { return "avc"; }

  /**
   * 始终重编码为 H.264 ultrafast — 保证极低延迟
   * copy 模式虽然 CPU 零开销，但摄像头 GOP 通常 1-2 秒，
   * 导致 PTZ 操作后要等关键帧才能看到画面变化（延迟 1-2s）
   * ultrafast 重编码 CPU 开销很低（~2% 单核/路），但 GOP 完全可控
   */
  private async getEncoderArgs(): Promise<string[]> {
    let encoder = this.runtimeConfig?.get().recording.encoder ?? "libx264";
    if (encoder === "auto") {
      encoder = await probeHardwareEncoder(this.ffmpegPath, this.runtimeConfig?.get().recording.vaapiDevice ?? "/dev/dri/renderD128");
    }
    switch (encoder) {
      case "h264_v4l2m2m":
        return ["-c:v", "h264_v4l2m2m", "-pix_fmt", "yuv420p",
          "-g", "1", "-keyint_min", "1",
          "-bf", "0"];
      case "h264_vaapi":
        return [
          "-vaapi_device", this.runtimeConfig?.get().recording.vaapiDevice ?? "/dev/dri/renderD128",
          "-c:v", "h264_vaapi",
          "-vf", "format=nv12,hwupload",
          "-qp", "23",
          "-g", "1", "-keyint_min", "1",
          /** 低延迟：禁用 B 帧 + 立即输出 + 异步深度 1 */
          "-bf", "0", "-flags", "+low_delay", "-async_depth", "1",
        ];
      case "h264_nvenc":
        return ["-c:v", "h264_nvenc", "-preset", "p1", "-tune", "ll",
          "-cq", "23", "-g", "1", "-keyint_min", "1",
          /** 低延迟：禁用 B 帧 + 零 lookahead + 零延迟输出 */
          "-bf", "0", "-rc-lookahead", "0", "-zerolatency", "1"];
      case "h264_qsv":
        return ["-c:v", "h264_qsv", "-preset", "veryfast",
          "-global_quality", "23", "-g", "1", "-keyint_min", "1",
          /** 低延迟：禁用 B 帧 + 异步深度 1 */
          "-bf", "0", "-async_depth", "1"];
      case "h264_videotoolbox":
        return ["-c:v", "h264_videotoolbox",
          "-q:v", "23",
          "-g", "1", "-keyint_min", "1",
          /** 低延迟：允许实时编码 */
          "-realtime", "1"];
      case "h264_amf":
        return ["-c:v", "h264_amf", "-usage", "ultralowlatency",
          "-quality", "speed", "-rc", "cqp", "-qp_i", "23", "-qp_p", "23",
          "-g", "1", "-keyint_min", "1"];
      default:
        return [
          "-c:v", "libx264",
          "-preset", "ultrafast",
          "-tune", "zerolatency",
          "-crf", "23",
          "-g", "1",
          "-keyint_min", "1",
          "-x264-params", "bframes=0:sync-lookahead=0:rc-lookahead=0",
        ];
    }
  }

  private async spawnFfmpeg(): Promise<void> {
    /**
     * 使用 ffmpeg 直接输出 fMP4 格式
     * 始终重编码为 H.264 ultrafast — 保证极低延迟（GOP 2帧 ~80ms@25fps）
     * 兼容 H.264/HEVC 等任意摄像头编码
     */
    const args = [
      "-rtsp_transport", "tcp",
      "-avioflags", "direct",
      "-fflags", "nobuffer+fastseek+genpts+discardcorrupt",
      "-flags", "low_delay",
      "-max_delay", "0",
      "-reorder_queue_size", "0",
      "-thread_queue_size", "1",
    ];

    args.push(
      "-analyzeduration", "100000",
      "-probesize", "32768",
      "-i", this.rtspUrl,
    );

    /** 始终重编码：保证 GOP 可控，PTZ 后即可看到画面变化 */
    const encoderArgs = await this.getEncoderArgs();
    args.push(...encoderArgs);
    /** 单线程：zerolatency 模式下帧级并行无效，减少多路并发时 CPU 争用 */
    args.push("-threads", "1");

    args.push(
      "-an",
      "-f", "mp4",
      "-movflags", "frag_keyframe+empty_moov+default_base_moof",
      /** 立即刷新到管道，避免 mp4 muxer 内部缓冲延迟 */
      "-flush_packets", "1",
      "pipe:1",
    );

    console.log(`${this.logTag} 启动 ffmpeg (fMP4 native): ${this.ffmpegPath} ${args.join(" ")}`);

    this.proc = spawn(this.ffmpegPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    /** 用低水位线包装 stdout，减少 ffmpeg → Node 管道的批量缓冲延迟 */
    const stdout = new Readable({ highWaterMark: 4096 }).wrap(this.proc.stdout!);
    let initCached = false;
    stdout.on("data", (chunk: Buffer) => {
      this.parser.feed(chunk, this.eventBus, this.config.id);

      /** 同时将 fMP4 数据喂给 JPEG 解码子进程 */
      this.feedJpegDecoder(chunk);

      /** 只在首次缓存 init segment，之后跳过热路径上的冗余赋值 */
      if (!initCached) {
        const init = this.parser.lastInitSegment;
        if (init) {
          this.cachedInit = init;
          initCached = true;
        }
      }

      if (!this.online) {
        this.online = true;
        this.eventBus.emit("extractor:online", { cameraId: this.config.id, source: "fmp4" });
        console.log(`${this.logTag} 流上线 (codec=${this.parser.lastInitSegment?.codec ?? "unknown"}, ${this.parser.videoWidth}x${this.parser.videoHeight})`);
      }
      this.retryCount = 0;
      /** 收到数据，重置看门狗 */
      this.resetWatchdog();
    });

    this.proc.stderr?.on("data", (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg.includes("error") || msg.includes("Error")) {
        console.error(`${this.logTag} ffmpeg error:`, msg);
      }
    });

    this.proc.on("exit", (code) => {
      console.log(`${this.logTag} ffmpeg 退出, code=${code}`);
      this.clearWatchdog();
      this.parser.reset();
      /** 清除缓存的 init segment（ffmpeg 重启后旧 init 不再兼容） */
      this.cachedInit = null;
      if (this.proc) {
        this.proc.unref();
        this.proc = null;
      }
      if (this.online) {
        this.online = false;
        this.eventBus.emit("extractor:offline", { cameraId: this.config.id, source: "fmp4" });
      }
      this.scheduleReconnect();
    });

    /** 启动看门狗：15 秒无数据则认为卡死 */
    this.resetWatchdog();
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

  /** 上次收到数据的时间 */
  private lastDataTime = 0;

  /** 重置看门狗：更新最后数据时间（不再高频创建/销毁定时器） */
  private resetWatchdog(): void {
    this.lastDataTime = Date.now();
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(() => {
      if (!this.proc) { this.clearWatchdog(); return; }
      if (Date.now() - this.lastDataTime > H264Fmp4Extractor.WATCHDOG_TIMEOUT) {
        console.warn(`${this.logTag} ffmpeg 3 秒无数据输出，可能卡死，强制重启`);
        this.killProcess();
      }
    }, 1000);
  }

  /** 清除看门狗定时器 */
  private clearWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    this.retryCount++;
    /** 超过 10 次后降频为每 5 分钟检查一次，避免已下线摄像头持续消耗资源 */
    const maxRetries = 10;
    let delay: number;
    if (this.retryCount > maxRetries) {
      delay = 300_000;
      if (this.retryCount === maxRetries + 1) {
        console.warn(`${this.logTag} 连续 ${maxRetries} 次重连失败，降频为每 5 分钟检查一次`);
      }
    } else {
      /** 首次 200ms 快速重连，后续指数退避（200ms, 400ms, 800ms, 1.6s, ...） */
      delay = Math.min(200 * Math.pow(2, this.retryCount - 1), 30_000);
    }
    console.log(`${this.logTag} ${delay / 1000}s 后重连 (第 ${this.retryCount} 次)`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.spawnFfmpeg();
    }, delay);
  }

  /** 启动 JPEG 解码子进程：从 fMP4 解码为 JPEG 帧 */
  private spawnJpegDecoder(): void {
    const width = this.config.detectWidth;

    const vfParts: string[] = [];
    vfParts.push("fps=15:round=zero");
    if (width > 0) vfParts.push(`scale=${width}:-4`);

    const args = [
      "-f", "mp4",
      "-flags", "low_delay",
      "-fflags", "nobuffer",
      "-i", "pipe:0",
      "-vf", vfParts.join(","),
      "-f", "image2pipe",
      "-vcodec", "mjpeg",
      "-q:v", String(Math.min(this.config.jpegQuality, 10)),
      "-an",
      "-threads", "2",
      "pipe:1",
    ];

    this.jpegProc = spawn(this.ffmpegPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.jpegProc.stdin?.on("error", () => {});
    this.jpegProc.stderr?.on("data", () => {});
    this.jpegProc.on("exit", () => {
      this.jpegProc?.unref();
      this.jpegProc = null;
      this.jpegSplitter = new JpegFrameSplitter();
    });

    const stdout = this.jpegProc.stdout;
    if (stdout) {
      stdout.on("data", (chunk: Buffer) => {
        const frames = this.jpegSplitter.feed(chunk);
        for (const frame of frames) {
          const now = Date.now();
          const payload = this.reusablePayload;
          payload.data = frame;
          payload.timestamp = now;
          this.eventBus.emit("detect:frame", payload);
          this.eventBus.emit("frame", payload);
        }
      });
    }
  }

  /** 将 fMP4 数据喂给 JPEG 解码子进程 */
  private feedJpegDecoder(data: Buffer): void {
    const stdin = this.jpegProc?.stdin;
    if (!stdin?.writable) return;
    stdin.write(data);
  }

  /** 关闭 JPEG 解码子进程 */
  private killJpegProc(): void {
    if (this.jpegProc) {
      const proc = this.jpegProc;
      this.jpegProc = null;
      proc.stdin?.destroy();
      proc.stdout?.destroy();
      proc.stderr?.destroy();
      proc.kill("SIGKILL");
      proc.unref();
    }
    this.jpegSplitter = new JpegFrameSplitter();
  }
}
