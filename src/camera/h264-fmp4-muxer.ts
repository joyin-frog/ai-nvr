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
  /** 音频 codec（如 "mp4a.40.2"），无音频时为空字符串 */
  audioCodec: string;
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
  /** 从 moov 中提取的视频 codec */
  private codec = "avc1.42C01E";
  /** 从 moov 中提取的音频 codec（空字符串表示无音频） */
  private audioCodec = "";
  /** timescale（从 moov 的 mdhd 提取） */
  private timescale = 0;
  /** 下一帧 PTS（增量式递增） */
  private nextPts = 0n;
  /** 首帧原始 PTS */
  private firstOriginalPts: bigint | null = null;
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
    this.timescale = 0;
    this.nextPts = 0n;
    this.firstOriginalPts = null;
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
        /** 从 moov 中提取 codec、分辨率和 timescale */
        this.extractCodecFromMoov(data);
        this.extractDimensionsFromMoov(data);
        this.extractTimescaleFromMoov(data);

        /** 组装 init segment: ftyp + moov（恰好 2 个 box，避免 Buffer.concat 开销） */
        const initData = concat2(this.completedBoxes[0]!.data, this.completedBoxes[1]!.data);
        const init: Fmp4InitSegment = {
          type: "init",
          codec: this.codec,
          audioCodec: this.audioCodec,
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
        let moofData = this.completedBoxes[0]!.data;
        const mdatData = this.completedBoxes[1]!.data;

        /** 重写 tfdt 为 wall clock PTS，对齐真实时间 */
        moofData = this.fixMoof(moofData);

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
    /** 提取音频 codec */
    const acodec = this.findAudioCodecInMoov(moov, 8);
    if (acodec) {
      this.audioCodec = acodec;
    }
  }

  /** 递归搜索 moov 中的音频轨道 codec（mp4a sample entry） */
  private findAudioCodecInMoov(data: Buffer, start: number): string | null {
    let offset = start;
    while (offset + 8 <= data.length) {
      const size = data.readUInt32BE(offset);
      const type = data.subarray(offset + 4, offset + 8).toString("ascii");
      if (size < 8 || offset + size > data.length) break;

      /** mp4a sample entry = AAC 音频 */
      if (type === "mp4a") {
        const payload = data.subarray(offset + 8, offset + size);
        const esds = this.findSubBoxInPayload(payload, "esds");
        if (esds && esds.length > 4) {
          /** esds 中包含 AudioObjectType，从 ES Descriptor 提取
           *  简化处理：直接返回 mp4a.40.2（AAC-LC） */
          return "mp4a.40.2";
        }
        return "mp4a.40.2";
      }

      /** 递归搜索容器 box */
      const isContainer = type === "moov" || type === "trak" || type === "mdia" || type === "minf" || type === "stbl" || type === "stsd";
      if (isContainer) {
        const childStart = offset + 8 + (type === "stsd" ? 8 : 0);
        const result = this.findAudioCodecInMoov(data, childStart);
        if (result) return result;
      }

      offset += size;
    }
    return null;
  }

  /** 在 audio sample entry payload 中搜索子 box（audio header = 28 字节） */
  private findSubBoxInPayload(payload: Buffer, target: string): Buffer | null {
    /** audio sample entry 头部: 6B reserved + 2B data_ref_idx + 8B reserved + 2B channel_count + 2B sample_size
     *  + 2B pre_defined + 2B reserved + 4B sample_rate = 28 bytes */
    let offset = 28;
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

  /** 从 moov 的 mdhd box 中提取 timescale */
  private extractTimescaleFromMoov(moov: Buffer): void {
    const ts = this.findTimescaleInBox(moov, 8);
    if (ts) this.timescale = ts;
  }

  private findTimescaleInBox(data: Buffer, start: number): number | null {
    let offset = start;
    while (offset + 8 <= data.length) {
      const size = data.readUInt32BE(offset);
      const type = data.subarray(offset + 4, offset + 8).toString("ascii");
      if (size < 8 || offset + size > data.length) break;

      if (type === "mdhd") {
        const version = data[offset + 8];
        /** version 0: timescale at +8+12, version 1: at +8+20 */
        const tsOffset = version === 0 ? offset + 20 : offset + 28;
        if (tsOffset + 4 <= data.length) return data.readUInt32BE(tsOffset);
      }

      if (type === "moov" || type === "trak" || type === "mdia") {
        const result = this.findTimescaleInBox(data, offset + 8);
        if (result !== null) return result;
      }

      offset += size;
    }
    return null;
  }

  /**
   * 修复 moof：重写 tfdt PTS 为均匀递增
   *
   * ffmpeg 在 -g 1 + frag_keyframe + split 模式下 tfdt 差值可能不等于实际帧间隔
   * 且 trun 中不含 sample_duration，导致 MSE 按错误的 PTS 速率播放
   *
   * 修复：用段计数器 + parser 实测帧率生成均匀 PTS
   */
  private fixMoof(moof: Buffer): Buffer {
    if (this.timescale === 0) return moof;

    /** 首帧：读取原始 PTS 作为基准 */
    if (this.firstOriginalPts === null) {
      const pts = this.extractTfdt(moof);
      if (pts === null) return moof;
      this.firstOriginalPts = pts;
      this.nextPts = pts;
      return moof;
    }

    /** 增量式 PTS：每帧 PTS = 上一帧 PTS + ptsStep
     *  ptsStep 动态跟随 parser 实测帧率，避免 fps 变化时 PTS 跳变 */
    const fps = this.currentFps > 0 ? this.currentFps : 15;
    const step = BigInt(Math.round(this.timescale / fps));
    this.nextPts += step;

    /** 原地写入 tfdt */
    this.writeTfdt(moof, this.nextPts);
    return moof;
  }

  /** 从 moof 提取 tfdt 原始 PTS */
  private extractTfdt(moof: Buffer): bigint | null {
    let off = 8;
    while (off + 8 <= moof.length) {
      const size = moof.readUInt32BE(off);
      const type = moof.subarray(off + 4, off + 8).toString("ascii");
      if (size < 8 || off + size > moof.length) break;
      if (type === "traf") {
        const end = off + size;
        let tOff = off + 8;
        while (tOff + 8 <= end) {
          const sSize = moof.readUInt32BE(tOff);
          const sType = moof.subarray(tOff + 4, tOff + 8).toString("ascii");
          if (sSize < 8 || tOff + sSize > end) break;
          if (sType === "tfdt") {
            const v = moof[tOff + 8]!;
            if (v === 1 && tOff + 20 <= end) return moof.readBigUInt64BE(tOff + 12);
            if (tOff + 16 <= end) return BigInt(moof.readUInt32BE(tOff + 12));
          }
          tOff += sSize;
        }
      }
      off += size;
    }
    return null;
  }

  /** 原地写入 tfdt PTS */
  private writeTfdt(moof: Buffer, pts: bigint): void {
    let off = 8;
    while (off + 8 <= moof.length) {
      const size = moof.readUInt32BE(off);
      const type = moof.subarray(off + 4, off + 8).toString("ascii");
      if (size < 8 || off + size > moof.length) break;
      if (type === "traf") {
        const end = off + size;
        let tOff = off + 8;
        while (tOff + 8 <= end) {
          const sSize = moof.readUInt32BE(tOff);
          const sType = moof.subarray(tOff + 4, tOff + 8).toString("ascii");
          if (sSize < 8 || tOff + sSize > end) break;
          if (sType === "tfdt") {
            const v = moof[tOff + 8]!;
            if (v === 1) {
              moof.writeBigUInt64BE(pts, tOff + 12);
            } else {
              moof.writeUInt32BE(Number(pts), tOff + 12);
            }
            return;
          }
          tOff += sSize;
        }
      }
      off += size;
    }
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
  /** JPEG 帧拆分器（从 fd3 读取） */
  private jpegSplitter = new JpegFrameSplitter();
  /** 复用的帧 payload */
  private reusablePayload: { cameraId: string; data: Buffer; timestamp: number };
  /** JPEG 帧率统计 */
  private jpegFrameCount = 0;
  private jpegFpsStart = Date.now();
  private jpegFps = 0;

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
    this.killProcess();
  }

  get isOnline(): boolean { return this.online; }

  get fps(): number { return this.parser.fps; }

  /** JPEG 检测帧率 */
  get detectFps(): number { return this.jpegFps; }

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
   * 构建完整 ffmpeg 参数（单进程 fMP4 + JPEG 双输出）
   * filter_complex split 解码一次，同时输出 fMP4（pipe:1）和 JPEG（pipe:3）
   */
  private async buildFfmpegArgs(): Promise<string[]> {
    let encoder = this.runtimeConfig?.get().recording.encoder ?? "libx264";
    if (encoder === "auto") {
      encoder = await probeHardwareEncoder(this.ffmpegPath, this.runtimeConfig?.get().recording.vaapiDevice ?? "/dev/dri/renderD128");
    }

    const detectFps = this.config.detectFps || 5;
    const detectWidth = this.config.detectWidth > 0 ? this.config.detectWidth : 640;
    const jpegQuality = Math.min(this.config.jpegQuality, 10);
    const scaleFilter = `scale=${detectWidth}:-4`;

    /** JPEG 分支 filter：fps 抽帧 + 缩放 */
    const jpegFilter = `fps=${detectFps}:round=zero,${scaleFilter}`;

    const inputArgs = [
      "-rtsp_transport", "tcp",
      "-avioflags", "direct",
      "-fflags", "nobuffer+fastseek+genpts+discardcorrupt",
      "-flags", "low_delay",
      "-max_delay", "0",
      "-reorder_queue_size", "0",
      "-thread_queue_size", "1",
      "-analyzeduration", "100000",
      "-probesize", "32768",
      "-i", this.rtspUrl,
    ];

    /** GOP 1 + frag_keyframe = 每帧 I 帧，每帧独立 fragment，MSE 即时解码 */
    const gopSize = 1;
    /** movflags: frag_keyframe 在每个关键帧处切 fragment，配合 -g 1 即每帧一个 fragment */
    const movflags = "frag_keyframe+empty_moov+default_base_moof";

    /** 音频编码参数：AAC 64kbps 单声道（-map 0:a? 的 ? 表示无音频流时不报错） */
    const audioArgs = ["-map", "0:a?", "-c:a", "aac", "-b:a", "64k", "-ac", "1"];

    switch (encoder) {
      case "h264_vaapi": {
        const vaapiDev = this.runtimeConfig?.get().recording.vaapiDevice ?? "/dev/dri/renderD128";
        return [
          ...inputArgs,
          "-vaapi_device", vaapiDev,
          "-filter_complex", `[0:v]split=2[v1][v2];[v1]format=nv12,hwupload[v1hw];[v2]${jpegFilter}[v2out]`,
          "-map", "[v1hw]", "-c:v", "h264_vaapi",
          "-qp", "28", "-g", String(gopSize), "-keyint_min", String(gopSize),
          "-bf", "0", "-flags", "+low_delay", "-async_depth", "1",
          ...audioArgs,
          "-f", "mp4", "-movflags", movflags,
          "-flush_packets", "1", "pipe:1",
          "-map", "[v2out]", "-c:v", "mjpeg", "-q:v", String(jpegQuality),
          "-f", "image2pipe", "pipe:3",
        ];
      }
      case "h264_nvenc":
        return [
          ...inputArgs,
          "-filter_complex", `[0:v]split=2[v1][v2];[v2]${jpegFilter}[v2out]`,
          "-map", "[v1]", "-c:v", "h264_nvenc", "-preset", "p1", "-tune", "ll",
          "-cq", "28", "-g", String(gopSize), "-keyint_min", String(gopSize),
          "-bf", "0", "-rc-lookahead", "0", "-zerolatency", "1",
          ...audioArgs,
          "-f", "mp4", "-movflags", movflags,
          "-flush_packets", "1", "pipe:1",
          "-map", "[v2out]", "-c:v", "mjpeg", "-q:v", String(jpegQuality),
          "-f", "image2pipe", "pipe:3",
        ];
      case "h264_qsv":
        return [
          ...inputArgs,
          "-filter_complex", `[0:v]split=2[v1][v2];[v2]${jpegFilter}[v2out]`,
          "-map", "[v1]", "-c:v", "h264_qsv", "-preset", "veryfast",
          "-global_quality", "28", "-g", String(gopSize), "-keyint_min", String(gopSize),
          "-bf", "0", "-async_depth", "1",
          ...audioArgs,
          "-f", "mp4", "-movflags", movflags,
          "-flush_packets", "1", "pipe:1",
          "-map", "[v2out]", "-c:v", "mjpeg", "-q:v", String(jpegQuality),
          "-f", "image2pipe", "pipe:3",
        ];
      case "h264_videotoolbox":
        return [
          ...inputArgs,
          "-filter_complex", `[0:v]split=2[v1][v2];[v2]${jpegFilter}[v2out]`,
          "-map", "[v1]", "-c:v", "h264_videotoolbox", "-q:v", "28",
          "-g", String(gopSize), "-keyint_min", String(gopSize), "-realtime", "1",
          ...audioArgs,
          "-f", "mp4", "-movflags", movflags,
          "-flush_packets", "1", "pipe:1",
          "-map", "[v2out]", "-c:v", "mjpeg", "-q:v", String(jpegQuality),
          "-f", "image2pipe", "pipe:3",
        ];
      case "h264_amf":
        return [
          ...inputArgs,
          "-filter_complex", `[0:v]split=2[v1][v2];[v2]${jpegFilter}[v2out]`,
          "-map", "[v1]", "-c:v", "h264_amf", "-usage", "ultralowlatency",
          "-quality", "speed", "-rc", "cqp", "-qp_i", "28", "-qp_p", "28",
          "-g", String(gopSize), "-keyint_min", String(gopSize),
          ...audioArgs,
          "-f", "mp4", "-movflags", movflags,
          "-flush_packets", "1", "pipe:1",
          "-map", "[v2out]", "-c:v", "mjpeg", "-q:v", String(jpegQuality),
          "-f", "image2pipe", "pipe:3",
        ];
      case "h264_v4l2m2m":
        return [
          ...inputArgs,
          "-filter_complex", `[0:v]split=2[v1][v2];[v2]${jpegFilter}[v2out]`,
          "-map", "[v1]", "-c:v", "h264_v4l2m2m", "-pix_fmt", "yuv420p",
          "-g", String(gopSize), "-keyint_min", String(gopSize), "-bf", "0",
          ...audioArgs,
          "-f", "mp4", "-movflags", movflags,
          "-flush_packets", "1", "pipe:1",
          "-map", "[v2out]", "-c:v", "mjpeg", "-q:v", String(jpegQuality),
          "-f", "image2pipe", "pipe:3",
        ];
      default:
        return [
          ...inputArgs,
          "-filter_complex", `[0:v]split=2[v1][v2];[v2]${jpegFilter}[v2out]`,
          "-map", "[v1]", "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
          "-crf", "28", "-g", String(gopSize), "-keyint_min", String(gopSize),
          "-x264-params", "bframes=0:sync-lookahead=0:rc-lookahead=0",
          "-threads", "2",
          ...audioArgs,
          "-f", "mp4", "-movflags", movflags,
          "-flush_packets", "1", "pipe:1",
          "-map", "[v2out]", "-c:v", "mjpeg", "-q:v", String(jpegQuality),
          "-f", "image2pipe", "pipe:3",
        ];
    }
  }

  private async spawnFfmpeg(): Promise<void> {
    /**
     * 单进程双输出：filter_complex split 解码一次
     * pipe:1 = fMP4（前端 MSE 播放 + 录像）
     * pipe:3 = JPEG（AI 检测 + MJPEG 回退 + 快照）
     */
    const args = await this.buildFfmpegArgs();

    console.log(`${this.logTag} 启动 ffmpeg (fMP4+JPEG 单进程): ${this.ffmpegPath} ${args.join(" ")}`);

    this.proc = spawn(this.ffmpegPath, args, {
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    });

    /** 高水位线 128KB：让单个 fMP4 segment 更可能一次读取完毕，减少 feed/flatten 调用 */
    const stdout = new Readable({ highWaterMark: 131072 }).wrap(this.proc.stdout!);
    let initCached = false;
    stdout.on("data", (chunk: Buffer) => {
      this.parser.feed(chunk, this.eventBus, this.config.id);

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
      this.resetWatchdog();
    });

    /** fd3 = JPEG 帧（filter_complex split 的第二个输出分支） */
    const jpegFd = this.proc.stdio[3];
    if (jpegFd) {
      const jpegReadable = new Readable({ highWaterMark: 65536 }).wrap(jpegFd as any);
      jpegReadable.on("data", (chunk: Buffer) => {
        const frames = this.jpegSplitter.feed(chunk);
        for (const frame of frames) {
          const now = Date.now();
          const payload = this.reusablePayload;
          payload.data = frame;
          payload.timestamp = now;
          this.eventBus.emit("detect:frame", payload);
          this.eventBus.emit("frame", payload);

          this.jpegFrameCount++;
          if (now - this.jpegFpsStart >= 5000) {
            this.jpegFps = this.jpegFrameCount * 1000 / (now - this.jpegFpsStart);
            this.jpegFrameCount = 0;
            this.jpegFpsStart = now;
          }
        }
      });
    }

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
      this.cachedInit = null;
      this.jpegSplitter = new JpegFrameSplitter();
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

    this.resetWatchdog();
  }

  private killProcess(): void {
    if (this.proc) {
      const proc = this.proc;
      this.proc = null;
      proc.stdout?.destroy();
      proc.stderr?.destroy();
      /** 关闭 fd3（JPEG 输出管道） */
      const fd3 = proc.stdio[3];
      if (fd3 && "destroy" in fd3) (fd3 as any).destroy();
      proc.kill("SIGKILL");
      /** 立即 unref 防止僵尸：exit 回调可能不会执行（bun --watch 重启时） */
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
}
