import { spawn } from "node:child_process";
import { type CameraConfig } from "@/config";
import { type EventBus } from "@/event-bus";

/** MP4 box header 大小 */
const BOX_HEADER_SIZE = 8;

/** fMP4 段类型 */
export interface Fmp4InitSegment {
  type: "init";
  /** 编码器信息（如 avc1.640029） */
  codec: string;
  /** 原始数据 */
  data: Buffer;
}

export interface Fmp4MediaSegment {
  type: "media";
  /** 原始数据 */
  data: Buffer;
}

export type Fmp4Segment = Fmp4InitSegment | Fmp4MediaSegment;

/**
 * 从 ffmpeg stdout 的 fMP4 流中按 box 边界分割出段
 * 初始化段：ftyp + moov
 * 媒体段：moof + mdat（成对）
 */
class Fmp4BoxParser {
  private buffer = Buffer.alloc(0);
  /** 是否已发送 init segment */
  private initSent = false;
  /** 收集 ftyp（在 moov 之前） */
  private ftypData: Buffer | null = null;

  /** 处理一块数据，返回完整段列表 */
  feed(data: Buffer): Fmp4Segment[] {
    this.buffer = Buffer.concat([this.buffer, data]);
    const segments: Fmp4Segment[] = [];

    while (this.buffer.length >= BOX_HEADER_SIZE) {
      const boxSize = this.buffer.readUInt32BE(0);
      const boxType = this.buffer.toString("ascii", 4, 8);

      /** size = 0 表示延伸到流结束，不会在 fMP4 直播中出现 */
      if (boxSize < BOX_HEADER_SIZE) {
        this.buffer = Buffer.alloc(0);
        break;
      }
      /** 不完整 box，等待更多数据 */
      if (boxSize > this.buffer.length) break;

      if (boxType === "ftyp") {
        this.ftypData = this.buffer.subarray(0, boxSize);
        this.buffer = this.buffer.subarray(boxSize);
      } else if (boxType === "moov") {
        if (!this.initSent && this.ftypData) {
          const initData = Buffer.concat([this.ftypData, this.buffer.subarray(0, boxSize)]);
          const codec = this.extractCodec(initData);
          segments.push({ type: "init", codec, data: initData });
          this.initSent = true;
          this.ftypData = null;
        }
        this.buffer = this.buffer.subarray(boxSize);
      } else if (boxType === "moof") {
        /** moof + mdat 必须成对 */
        if (this.buffer.length < boxSize + BOX_HEADER_SIZE) break;

        const mdatSize = this.buffer.readUInt32BE(boxSize);
        const mdatType = this.buffer.toString("ascii", boxSize + 4, boxSize + 8);

        if (mdatType !== "mdat") {
          /** 跳过未知 box */
          this.buffer = this.buffer.subarray(boxSize);
          continue;
        }

        const totalSize = boxSize + mdatSize;
        if (totalSize > this.buffer.length) break;

        segments.push({
          type: "media",
          data: Buffer.from(this.buffer.subarray(0, totalSize)),
        });
        this.buffer = this.buffer.subarray(totalSize);
      } else {
        /** 跳过未知 box */
        this.buffer = this.buffer.subarray(boxSize);
      }
    }

    return segments;
  }

  /** 从 init segment 提取 codec 字符串 */
  private extractCodec(initData: Buffer): string {
    /** 简化：搜索 avcC box 获取 profile/level */
    const avcC = this.findBox(initData, "avcC");
    if (avcC && avcC.length >= 8) {
      const profile = avcC[1]!;
      const compat = avcC[2]!;
      const level = avcC[3]!;
      return `avc1.${profile.toString(16).padStart(2, "0")}${compat.toString(16).padStart(2, "0")}${level.toString(16).padStart(2, "0")}`;
    }
    return "avc1.42C01E";
  }

  /** 在 buffer 中查找指定类型的 box 的 body */
  private findBox(buf: Buffer, type: string): Buffer | null {
    let offset = 0;
    while (offset + BOX_HEADER_SIZE <= buf.length) {
      const size = buf.readUInt32BE(offset);
      const boxType = buf.toString("ascii", offset + 4, offset + 8);
      if (size < BOX_HEADER_SIZE || offset + size > buf.length) break;
      if (boxType === type) {
        return buf.subarray(offset + 8, offset + size);
      }
      offset += size;
    }
    return null;
  }
}

/**
 * fMP4 流提取器
 * 从 RTSP 流中提取 fMP4 段（H.264 copy，零转码）
 */
export class Fmp4Extractor {
  private proc: ReturnType<typeof spawn> | null = null;
  private parser = new Fmp4BoxParser();
  private running = false;
  private retryCount = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private online = false;
  private logTag: string;
  /** 帧率统计 */
  private segmentCount = 0;
  private segmentCountStart = Date.now();
  private currentFps = 0;
  /** 缓存 init segment（新客户端连接时发送） */
  private cachedInit: Fmp4InitSegment | null = null;

  constructor(
    private config: CameraConfig,
    private ffmpegPath: string,
    private eventBus: EventBus,
    private rtspUrl: string,
  ) {
    this.logTag = `[fMP4][${config.id}]`;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.spawnFfmpeg();
  }

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

  get isOnline(): boolean { return this.online; }

  /** 获取缓存的 init segment */
  get initSegment(): Fmp4InitSegment | null { return this.cachedInit; }

  /** 获取当前 FPS */
  get fps(): number { return this.currentFps; }

  private spawnFfmpeg(): void {
    const args = [
      "-rtsp_transport", "tcp",
      "-fflags", "nobuffer",
      "-flags", "low_delay",
      "-max_delay", "0",
      "-reorder_queue_size", "0",
      "-analyzeduration", "1000000",
      "-probesize", "500000",
      "-i", this.rtspUrl,
      "-c:v", "copy",
      "-an",
      "-f", "mp4",
      "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
      "-frag_duration", "0.3",
      "pipe:1",
    ];

    console.log(`${this.logTag} 启动 ffmpeg: ${this.ffmpegPath} ${args.join(" ")}`);

    this.proc = spawn(this.ffmpegPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.proc.stdout?.on("data", (chunk: Buffer) => {
      const segments = this.parser.feed(chunk);
      for (const seg of segments) {
        if (seg.type === "init") {
          this.cachedInit = seg;
          this.eventBus.emit("fmp4:init", { cameraId: this.config.id, segment: seg });
        } else {
          this.eventBus.emit("fmp4:segment", { cameraId: this.config.id, data: seg.data });

          /** FPS 统计 */
          this.segmentCount++;
          const now = Date.now();
          if (now - this.segmentCountStart >= 5000) {
            this.currentFps = this.segmentCount * 1000 / (now - this.segmentCountStart);
            this.segmentCount = 0;
            this.segmentCountStart = now;
          }
        }

        if (!this.online) {
          this.online = true;
          this.eventBus.emit("camera:online", { cameraId: this.config.id });
          console.log(`${this.logTag} 流上线`);
        }
        this.retryCount = 0;
      }
    });

    this.proc.stderr?.on("data", (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg.includes("error") || msg.includes("Error")) {
        console.error(`${this.logTag} ffmpeg error:`, msg);
      }
    });

    this.proc.on("exit", (code) => {
      console.log(`${this.logTag} ffmpeg 退出, code=${code}`);
      this.online = false;
      this.eventBus.emit("camera:offline", { cameraId: this.config.id });
      this.scheduleReconnect();
    });
  }

  private killProcess(): void {
    if (this.proc) {
      this.proc.kill("SIGKILL");
      this.proc.unref();
      this.proc = null;
    }
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    this.retryCount++;
    const delay = Math.min(1000 * Math.pow(2, this.retryCount - 1), 30_000);
    console.log(`${this.logTag} ${delay / 1000}s 后重连 (第 ${this.retryCount} 次)`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.spawnFfmpeg();
    }, delay);
  }
}
