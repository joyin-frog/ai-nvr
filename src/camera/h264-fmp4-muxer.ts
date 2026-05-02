import { type EventBus } from "@/event-bus";
import { type CameraConfig } from "@/config";
import { spawn } from "node:child_process";

/** fMP4 段类型 */
export interface Fmp4InitSegment {
  type: "init";
  codec: string;
  data: Buffer;
}

export interface Fmp4MediaSegment {
  type: "media";
  data: Buffer;
}

export type Fmp4Segment = Fmp4InitSegment | Fmp4MediaSegment;

/**
 * ffmpeg fMP4 流解析器
 * 解析 ffmpeg 输出的 fMP4 二进制流，拆分为 init/media segment
 * ffmpeg 使用 `-f mp4 -movflags frag_keyframe+empty_moov+default_base_moof` 输出标准 fMP4
 */
class Fmp4StreamParser {
  /** 未处理的缓冲区 */
  private buffer = Buffer.alloc(0);
  /** 待合并的 chunks（延迟 flatten 减少 GC） */
  private pendingChunks: Buffer[] = [];
  /** 已解析出的完整 box 列表（等待组装为 segment） */
  private completedBoxes: Array<{ type: string; data: Buffer }> = [];
  /** 是否已收集到 init segment (ftyp + moov) */
  private initCollected = false;
  /** 缓存的 init segment */
  private cachedInit: Fmp4InitSegment | null = null;
  /** 最近一个 media segment（用于新客户端首帧显示） */
  private lastMediaData: Buffer | null = null;
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

  feed(data: Buffer, eventBus: EventBus, cameraId: string): void {
    if (this.pendingChunks.length === 0 && this.buffer.length === 0) {
      this.buffer = Buffer.from(data);
    } else {
      this.pendingChunks.push(data);
    }
    this.parseBoxes(eventBus, cameraId);
  }

  get fps(): number { return this.currentFps; }

  get lastInitSegment(): Fmp4InitSegment | null { return this.cachedInit; }

  get videoWidth(): number { return this.width; }
  get videoHeight(): number { return this.height; }

  get lastMediaSegment(): Buffer | null { return this.lastMediaData; }

  reset(): void {
    this.buffer = Buffer.alloc(0);
    this.pendingChunks = [];
    this.completedBoxes = [];
    this.initCollected = false;
    this.segmentCount = 0;
    this.segmentCountStart = Date.now();
    this.currentFps = 0;
    /** 清除缓存的 init/media segment，避免 ffmpeg 重启后旧数据与新流不兼容 */
    this.cachedInit = null;
    this.lastMediaData = null;
  }

  /** 将 pending chunks 合并到 buffer */
  private flattenIfNeeded(): void {
    if (this.pendingChunks.length === 0) return;
    this.pendingChunks.unshift(this.buffer);
    this.buffer = Buffer.concat(this.pendingChunks);
    this.pendingChunks = [];
  }

  /** 解析 ISO BMFF boxes */
  private parseBoxes(eventBus: EventBus, cameraId: string): void {
    this.flattenIfNeeded();
    let buf = this.buffer;
    let offset = 0;

    while (offset < buf.length) {
      /** box header 至少需要 8 字节（4字节 size + 4字节 type） */
      if (buf.length - offset < 8) break;

      const boxSize = buf.readUInt32BE(offset);
      const boxType = buf.subarray(offset + 4, offset + 8).toString("ascii");

      /** size=0 表示 box 延伸到文件末尾 */
      const actualSize = boxSize === 0 ? buf.length - offset : boxSize;

      /** size=1 表示使用 8 字节 extended size */
      if (boxSize === 1) {
        if (buf.length - offset < 16) break;
        const extSize = Number(buf.readBigUInt64BE(offset + 8));
        if (buf.length - offset < extSize) break;
        const boxData = Buffer.from(buf.subarray(offset, offset + extSize));
        this.handleBox(boxType, boxData, eventBus, cameraId);
        offset += extSize;
        continue;
      }

      /** 数据不完整，等下次 */
      if (actualSize < 8 || buf.length - offset < actualSize) break;

      const boxData = Buffer.from(buf.subarray(offset, offset + actualSize));
      this.handleBox(boxType, boxData, eventBus, cameraId);
      offset += actualSize;
    }

    /** 保留未处理的数据 */
    this.buffer = offset > 0 ? Buffer.from(buf.subarray(offset)) : buf;
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

        /** 组装 init segment: ftyp + moov */
        const initData = Buffer.concat(this.completedBoxes.map(b => b.data));
        const init: Fmp4InitSegment = {
          type: "init",
          codec: this.codec,
          data: initData,
        };
        this.cachedInit = init;
        eventBus.emit("fmp4:init", { cameraId, segment: init });
        this.initCollected = true;
        this.completedBoxes = [];
      }
    } else {
      /** 收集 media segment: moof + mdat */
      this.completedBoxes.push({ type, data });

      /** moof 后面跟的 mdat 组成一个完整的 media segment */
      if (type === "mdat" && this.completedBoxes.some(b => b.type === "moof")) {
        const mediaData = Buffer.concat(this.completedBoxes.map(b => b.data));

        /** 缓存最近一个 media segment（用于新客户端首帧） */
        this.lastMediaData = mediaData;

        eventBus.emit("fmp4:segment", { cameraId, data: mediaData });
        this.completedBoxes = [];

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
  private retryCount = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** 看门狗：检测 ffmpeg 卡死（无数据输出） */
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private logTag: string;
  /** 缓存 init segment（新客户端连接时发送） */
  private cachedInit: Fmp4InitSegment | null = null;
  /** copy 模式是否失败过（HEVC 等不兼容编码） */
  private lastCopyFailed = false;

  constructor(
    private config: CameraConfig,
    private ffmpegPath: string,
    private eventBus: EventBus,
    private rtspUrl: string,
  ) {
    this.logTag = `[Video-fMP4][${config.id}]`;
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
      this.eventBus.emit("camera:offline", { cameraId: this.config.id });
    }
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

  private spawnFfmpeg(): void {
    /**
     * 使用 ffmpeg 直接输出 fMP4 格式
     * 策略：先尝试 copy（零 CPU 开销），copy 失败时 fallback 到 libx264 转码
     * copy 模式：摄像头输出 H.264 → 直接封装 fMP4，CPU 接近 0
     * transcode 模式：HEVC 等不兼容编码 → libx264 转码
     */
    const isTranscode = this.lastCopyFailed;
    const args = [
      "-rtsp_transport", "tcp",
      /** 两种模式都启用低延迟 */
      "-fflags", "nobuffer",
      "-flags", "low_delay",
      "-max_delay", "0",
      "-reorder_queue_size", "0",
    ];

    args.push(
      "-analyzeduration", "1000000",
      "-probesize", "500000",
      "-i", this.rtspUrl,
    );

    if (isTranscode) {
      /** copy 持续失败时回退到转码 */
      args.push(
        "-c:v", "libx264",
        "-preset", "superfast",
        "-tune", "zerolatency",
        "-crf", "23",
        "-x264-params", "keyint=30:min-keyint=15:bframes=0",
      );
    } else {
      /** 零转码 copy — CPU 开销极低 */
      args.push("-c:v", "copy");
    }

    args.push(
      "-an",
      "-f", "mp4",
      "-movflags", "frag_keyframe+empty_moov+default_base_moof",
      /** 强制每秒切割一个 fMP4 段，降低首帧和端到端延迟 */
      "-frag_duration", "1",
      "pipe:1",
    );

    console.log(`${this.logTag} 启动 ffmpeg (fMP4 native): ${this.ffmpegPath} ${args.join(" ")}`);

    this.proc = spawn(this.ffmpegPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.proc.stdout?.on("data", (chunk: Buffer) => {
      this.parser.feed(chunk, this.eventBus, this.config.id);

      const init = this.parser.lastInitSegment;
      if (init) {
        this.cachedInit = init;
      }

      if (!this.online) {
        this.online = true;
        this.eventBus.emit("camera:online", { cameraId: this.config.id });
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
      /** 检测 HEVC 码流 — copy 模式下立即 kill 进程并回退到转码 */
      if (!this.lastCopyFailed && (msg.includes("hevc") || msg.includes("HEVC") || msg.includes("hvc1"))) {
        this.lastCopyFailed = true;
        console.log(`${this.logTag} 检测到 HEVC 码流，立即切换到转码模式`);
        this.killProcess();
      }
    });

    this.proc.on("exit", (code) => {
      console.log(`${this.logTag} ffmpeg 退出, code=${code}`);
      this.clearWatchdog();
      this.parser.reset();
      /** 清除缓存的 init segment（ffmpeg 重启后旧 init 不再兼容） */
      this.cachedInit = null;
      if (this.online) {
        this.online = false;
        this.eventBus.emit("camera:offline", { cameraId: this.config.id });
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

  /** 重置看门狗定时器（每次收到数据时调用） */
  private resetWatchdog(): void {
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    this.watchdogTimer = setTimeout(() => {
      if (!this.proc) return;
      console.warn(`${this.logTag} ffmpeg 15 秒无数据输出，可能卡死，强制重启`);
      this.killProcess();
      /** killProcess 后 exit 事件会触发 scheduleReconnect */
    }, 15_000);
  }

  /** 清除看门狗定时器 */
  private clearWatchdog(): void {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
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
      delay = Math.min(1000 * Math.pow(2, this.retryCount - 1), 30_000);
    }
    console.log(`${this.logTag} ${delay / 1000}s 后重连 (第 ${this.retryCount} 次)`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.spawnFfmpeg();
    }, delay);
  }
}
