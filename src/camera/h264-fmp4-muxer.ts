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

/** 码流类型 */
type CodecType = "avc" | "hevc";

/** H.264 NAL unit type 常量 */
const AVC_NAL_NON_IDR = 1;
const AVC_NAL_IDR = 5;
const AVC_NAL_SPS = 7;
const AVC_NAL_PPS = 8;

/** HEVC NAL unit type 常量 */
const HEVC_NAL_TRAIL_N = 0;
const HEVC_NAL_TRAIL_R = 1;
const HEVC_NAL_IDR_W_RADL = 19;
const HEVC_NAL_IDR_N_LP = 20;
const HEVC_NAL_VPS = 32;
const HEVC_NAL_SPS = 33;
const HEVC_NAL_PPS = 34;

/**
 * 视频裸流 → fMP4 转换器
 * 自动检测 H.264/HEVC 码流，解析 NAL 单元并封装为 fMP4 段
 * 零转码（-c:v copy），CPU 开销极低
 */
class VideoToFmp4Muxer {
  /** 未处理的缓冲区 */
  private buffer = Buffer.alloc(0);
  /** 待合并的数据块（延迟 flatten，减少 feed 热路径 GC 压力） */
  private pendingChunks: Buffer[] = [];
  /** 已提取但未分组的 NAL 单元 */
  private pendingNals: Buffer[] = [];
  /** 上一个 VCL NAL 的类型（用于检测 access unit 边界） */
  private lastVclType = -1;
  /** 码流类型（自动检测） */
  private codecType: CodecType | null = null;
  /** VPS 缓存（HEVC） */
  private vps: Buffer | null = null;
  /** SPS 缓存 */
  private sps: Buffer | null = null;
  /** PPS 缓存 */
  private pps: Buffer | null = null;
  /** 是否已发送 init segment */
  private initSent = false;
  /** 最近生成的 init segment */
  private lastInit: Fmp4InitSegment | null = null;
  /** 视频宽度（从 SPS 解析） */
  private width = 0;
  /** 视频高度（从 SPS 解析） */
  private height = 0;
  /** 序列号 */
  private sequenceNumber = 0;
  /** 累计解码时间（90kHz 时钟） */
  private nextDts = 0;
  /** 帧率统计 */
  private frameCount = 0;
  private frameCountStart = Date.now();
  private currentFps = 0;
  /** 帧持续时间（90kHz），动态计算 */
  private frameDuration = 3000;
  /** 上一帧的 wall-clock 时间（用于动态计算帧间隔） */
  private lastFrameWallTime = 0;
  /** 帧间隔平滑窗口（最近 N 帧的平均间隔） */
  private frameIntervals: number[] = [];
  /** 平滑窗口大小 */
  private static readonly FPS_WINDOW = 30;
  /** 当前 segment 中累积的帧 */
  private segmentFrames: Buffer[] = [];
  /** 当前 segment 的起始 DTS */
  private segmentStartDts = 0;
  /** 当前 segment 中每帧的大小（用于 trun） */
  private segmentFrameSizes: number[] = [];
  /** 当前 segment 中每帧是否关键帧 */
  private segmentFrameFlags: boolean[] = [];
  /** 每个 segment 累积的最大帧数，超过则强制刷新 */
  private static readonly MAX_SEGMENT_FRAMES = 2;
  /** 是否已经在这个 segment 中遇到过 IDR（避免非起始 IDR 触发重复切分） */
  private segmentHasIdr = false;

  feed(data: Buffer, eventBus: EventBus, cameraId: string): void {
    /** 延迟合并：只在解析前 flatten，减少 feed 热路径上的 Buffer.concat 开销 */
    if (this.pendingChunks.length === 0 && this.buffer.length === 0) {
      this.buffer = Buffer.from(data);
    } else {
      this.pendingChunks.push(data);
    }
    this.flattenIfNeeded();
    this.extractNals(eventBus, cameraId);
  }

  /** 将 pending chunks 合并到 this.buffer（仅在解析前执行一次） */
  private flattenIfNeeded(): void {
    if (this.pendingChunks.length === 0) return;
    this.pendingChunks.unshift(this.buffer);
    this.buffer = Buffer.concat(this.pendingChunks);
    this.pendingChunks = [];
  }

  get fps(): number { return this.currentFps; }

  get lastInitSegment(): Fmp4InitSegment | null { return this.lastInit; }

  /** 最近一个 media segment（用于新客户端快速显示首帧） */
  private lastMediaData: Buffer | null = null;
  get lastMediaSegment(): Buffer | null { return this.lastMediaData; }

  /** 获取检测到的码流类型 */
  get detectedCodec(): CodecType | null { return this.codecType; }

  flushRemaining(eventBus: EventBus, cameraId: string): void {
    this.flushAccessUnit(eventBus, cameraId);
    if (this.segmentFrames.length > 0) {
      this.flushSegment(eventBus, cameraId);
    }
  }

  reset(): void {
    this.buffer = Buffer.alloc(0);
    this.pendingNals = [];
    this.lastVclType = -1;
    this.initSent = false;
    this.lastInit = null;
    this.segmentFrames = [];
    this.segmentFrameSizes = [];
    this.segmentFrameFlags = [];
    this.segmentHasIdr = false;
    this.nextDts = 0;
    this.sequenceNumber = 0;
    this.frameCount = 0;
    this.frameCountStart = Date.now();
    this.currentFps = 0;
    this.lastFrameWallTime = 0;
    this.frameIntervals = [];
    this.frameDuration = 3000;
  }

  /** 提取 NAL 单元（Annex B 起始码搜索，H.264 和 HEVC 通用） */
  private extractNals(eventBus: EventBus, cameraId: string): void {
    const buf = this.buffer;
    const len = buf.length;
    if (len < 4) return;

    /** 扫描所有起始码位置（3字节 00 00 01 和 4字节 00 00 00 01） */
    const starts: number[] = [];
    let i = 0;
    while (i <= len - 3) {
      if (buf[i] === 0 && buf[i + 1] === 0) {
        if (buf[i + 2] === 1) {
          starts.push(i);
          i += 3;
          continue;
        }
        if (buf[i + 2] === 0 && i + 3 < len && buf[i + 3] === 1) {
          starts.push(i);
          i += 4;
          continue;
        }
      }
      i++;
    }

    if (starts.length === 0) {
      if (len > 3) this.buffer = buf.subarray(len - 3);
      return;
    }

    /** 提取每个 NAL 单元 */
    for (let s = 0; s < starts.length; s++) {
      const start = starts[s]!;
      const codeLen = (start + 3 < len && buf[start + 2] === 0 && buf[start + 3] === 1) ? 4 : 3;
      const nalStart = start + codeLen;
      const nalEnd = s + 1 < starts.length ? starts[s + 1]! : len;

      if (nalEnd <= nalStart) continue;
      const nalData = Buffer.from(buf.subarray(nalStart, nalEnd));
      this.processNal(nalData, eventBus, cameraId);
    }

    /** 保留尾部不完整数据 */
    this.buffer = buf.subarray(starts[starts.length - 1]!);
  }

  /** 处理单个 NAL 单元 */
  private processNal(nal: Buffer, eventBus: EventBus, cameraId: string): void {
    if (nal.length === 0) return;

    /** 自动检测码流类型 */
    if (!this.codecType) {
      const firstByte = nal[0]!;
      const h264Type = firstByte & 0x1f;
      const hevcType = (firstByte >> 1) & 0x3f;
      /** 只在非 VCL NAL 上检测（SPS/PPS/VPS 等） */
      if (hevcType >= 32 && hevcType <= 34) {
        this.codecType = "hevc";
      } else if (h264Type === 7 || h264Type === 8) {
        this.codecType = "avc";
      } else if (hevcType === 19 || hevcType === 20) {
        this.codecType = "hevc";
      } else if (h264Type === 5) {
        this.codecType = "avc";
      }
    }

    if (this.codecType === "hevc") {
      this.processHevcNal(nal, eventBus, cameraId);
    } else {
      this.processAvcNal(nal, eventBus, cameraId);
    }
  }

  /** 处理 H.264 NAL */
  private processAvcNal(nal: Buffer, eventBus: EventBus, cameraId: string): void {
    const nalType = nal[0]! & 0x1f;

    if (nalType === AVC_NAL_SPS) {
      this.sps = nal;
      this.parseAvcSpsDimensions(nal);
      this.flushAccessUnit(eventBus, cameraId);
      this.pendingNals.push(nal);
    } else if (nalType === AVC_NAL_PPS) {
      this.pps = nal;
      this.pendingNals.push(nal);
    } else if (nalType === AVC_NAL_IDR) {
      this.flushAccessUnit(eventBus, cameraId);
      this.pendingNals.push(nal);
      this.lastVclType = AVC_NAL_IDR;
    } else if (nalType === AVC_NAL_NON_IDR) {
      const firstMb = this.parseExpGolomb(nal, 1);
      if (firstMb === 0 && this.lastVclType >= 0) {
        this.flushAccessUnit(eventBus, cameraId);
      }
      this.pendingNals.push(nal);
      this.lastVclType = AVC_NAL_NON_IDR;
    }
  }

  /** 处理 HEVC NAL */
  private processHevcNal(nal: Buffer, eventBus: EventBus, cameraId: string): void {
    const nalType = (nal[0]! >> 1) & 0x3f;

    if (nalType === HEVC_NAL_VPS) {
      this.vps = nal;
    } else if (nalType === HEVC_NAL_SPS) {
      this.sps = nal;
      this.parseHevcSpsDimensions(nal);
      this.flushAccessUnit(eventBus, cameraId);
      this.pendingNals.push(nal);
    } else if (nalType === HEVC_NAL_PPS) {
      this.pps = nal;
      this.pendingNals.push(nal);
    } else if (nalType === HEVC_NAL_IDR_W_RADL || nalType === HEVC_NAL_IDR_N_LP) {
      this.flushAccessUnit(eventBus, cameraId);
      this.pendingNals.push(nal);
      this.lastVclType = nalType;
    } else if (nalType === HEVC_NAL_TRAIL_R || nalType === HEVC_NAL_TRAIL_N) {
      /** HEVC access unit 边界：first_slice_segment_in_pic_flag == 1 表示新帧 */
      /** first_slice_segment_in_pic_flag 在 NAL header 之后的第一位 */
      if (nal.length > 2) {
        const firstSlice = (nal[2]! >> 7) & 1;
        if (firstSlice === 1 && this.lastVclType >= 0) {
          this.flushAccessUnit(eventBus, cameraId);
        }
      }
      this.pendingNals.push(nal);
      this.lastVclType = nalType;
    }
  }

  /** 完成一个 access unit（帧） */
  private flushAccessUnit(eventBus: EventBus, cameraId: string): void {
    if (this.pendingNals.length === 0) return;

    const isHevc = this.codecType === "hevc";

    /** 检查是否有 VCL NAL */
    const hasVcl = this.pendingNals.some(n => {
      if (isHevc) {
        const t = (n[0]! >> 1) & 0x3f;
        return t === HEVC_NAL_IDR_W_RADL || t === HEVC_NAL_IDR_N_LP || t === HEVC_NAL_TRAIL_R || t === HEVC_NAL_TRAIL_N;
      }
      const t = n[0]! & 0x1f;
      return t === AVC_NAL_IDR || t === AVC_NAL_NON_IDR;
    });
    if (!hasVcl) {
      this.pendingNals = [];
      this.lastVclType = -1;
      return;
    }

    /** 判断是否是 IDR 帧 */
    const isIdr = this.pendingNals.some(n => {
      if (isHevc) {
        const t = (n[0]! >> 1) & 0x3f;
        return t === HEVC_NAL_IDR_W_RADL || t === HEVC_NAL_IDR_N_LP;
      }
      return (n[0]! & 0x1f) === AVC_NAL_IDR;
    });

    /** 发送 init segment */
    if (isIdr && this.sps && this.pps) {
      const initSegment = isHevc ? this.buildHevcInitSegment() : this.buildAvcInitSegment();
      if (initSegment) {
        const codec = isHevc ? this.extractHevcCodec() : this.extractAvcCodec();
        const init: Fmp4InitSegment = { type: "init" as const, codec, data: initSegment };
        this.lastInit = init;
        eventBus.emit("fmp4:init", { cameraId, segment: init });
        this.initSent = true;
      }
    }

    /** 将 NAL 从 Annex B 转为 AVCC/HVCC 格式（4字节长度前缀） */
    const frameData = this.nalsToLengthPrefix(this.pendingNals);
    const frameSize = frameData.length;

    /** IDR 帧：如果有累积帧则先发送当前段，然后开始新段 */
    if (isIdr && this.segmentFrames.length > 0) {
      this.flushSegment(eventBus, cameraId);
      this.segmentHasIdr = false;
    }
    /** 记录此段中是否包含 IDR */
    if (isIdr) {
      this.segmentHasIdr = true;
    }

    if (this.segmentFrames.length === 0) {
      this.segmentStartDts = this.nextDts;
    }

    /** 动态帧持续时间：基于 wall-clock 帧间隔平滑计算 */
    const now = performance.now();
    if (this.lastFrameWallTime > 0) {
      const interval = now - this.lastFrameWallTime;
      if (interval > 0 && interval < 5000) {
        this.frameIntervals.push(interval);
        if (this.frameIntervals.length > VideoToFmp4Muxer.FPS_WINDOW) {
          this.frameIntervals.shift();
        }
        /** 计算平均帧间隔（ms），转为 90kHz ticks */
        const avgInterval = this.frameIntervals.reduce((a, b) => a + b, 0) / this.frameIntervals.length;
        this.frameDuration = Math.round(avgInterval * 90);
      }
    }
    this.lastFrameWallTime = now;

    this.segmentFrames.push(frameData);
    this.segmentFrameSizes.push(frameSize);
    this.segmentFrameFlags.push(isIdr);
    this.nextDts += this.frameDuration;

    /**
     * 段发送策略：
     * - 有 IDR 帧且帧数达到阈值：立即发送（保证前端尽早开始播放）
     * - 非 IDR 段但帧数超过 2 倍阈值：强制发送（防止 GOP 过大导致延迟堆积）
     */
    const maxFrames = VideoToFmp4Muxer.MAX_SEGMENT_FRAMES;
    if (this.segmentHasIdr && this.segmentFrames.length >= maxFrames) {
      this.flushSegment(eventBus, cameraId);
      this.segmentHasIdr = false;
    } else if (!this.segmentHasIdr && this.segmentFrames.length >= maxFrames * 2) {
      this.flushSegment(eventBus, cameraId);
    }

    /** FPS 统计 */
    this.frameCount++;
    const fpsNow = Date.now();
    if (fpsNow - this.frameCountStart >= 5000) {
      this.currentFps = this.frameCount * 1000 / (fpsNow - this.frameCountStart);
      this.frameCount = 0;
      this.frameCountStart = fpsNow;
    }

    this.pendingNals = [];
    this.lastVclType = -1;
  }

  /** 将 NAL 数组转为 4 字节长度前缀格式 */
  private nalsToLengthPrefix(nals: Buffer[]): Buffer {
    const parts: Buffer[] = [];
    for (const nal of nals) {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(nal.length, 0);
      parts.push(len, nal);
    }
    return Buffer.concat(parts);
  }

  // ==================== H.264 fMP4 构建 ====================

  private buildAvcInitSegment(): Buffer | null {
    if (!this.sps || !this.pps) return null;

    const ftyp = this.box("ftyp",
      Buffer.from("isom", "ascii"),
      this.u32(0x200),
      Buffer.from("isomiso6avc1mp41", "ascii"),
    );

    const avcC = this.buildAvcC(this.sps, this.pps);
    const sampleEntry = this.buildVisualSampleEntry("avc1", avcC);
    const moov = this.buildMoov(sampleEntry);

    return Buffer.concat([ftyp, moov]);
  }

  private buildAvcC(sps: Buffer, pps: Buffer): Buffer {
    const rawSps = this.removeEmulationPrevention(sps);
    const rawPps = this.removeEmulationPrevention(pps);

    const data = Buffer.alloc(11 + rawSps.length + rawPps.length);
    let off = 0;
    data[off++] = 1;
    data[off++] = rawSps[1]!;
    data[off++] = rawSps[2]!;
    data[off++] = rawSps[3]!;
    data[off++] = 0xFF;
    data[off++] = 0xE1;
    data.writeUInt16BE(rawSps.length, off); off += 2;
    rawSps.copy(data, off); off += rawSps.length;
    data[off++] = 1;
    data.writeUInt16BE(rawPps.length, off); off += 2;
    rawPps.copy(data, off);

    return this.box("avcC", data.subarray(0, off));
  }

  private extractAvcCodec(): string {
    if (!this.sps || this.sps.length < 4) return "avc1.42C01E";
    const profile = this.sps[1]!;
    const compat = this.sps[2]!;
    const level = this.sps[3]!;
    return `avc1.${profile.toString(16).padStart(2, "0")}${compat.toString(16).padStart(2, "0")}${level.toString(16).padStart(2, "0")}`;
  }

  /** 解析 H.264 SPS 宽高 */
  private parseAvcSpsDimensions(sps: Buffer): void {
    const raw = this.removeEmulationPrevention(sps);
    let off = 4 * 8;
    off += this.expGolombSkip(raw, off);
    const profile = raw[1]!;
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
      const chromaFormat = this.expGolombRead(raw, off); off += this.expGolombSkip(raw, off);
      if (chromaFormat === 3) off += 1;
      off += this.expGolombSkip(raw, off);
      off += this.expGolombSkip(raw, off);
      off += 1;
      if (raw[off >> 3]! & (1 << (7 - (off & 7)))) {
        off += 1;
        for (let i = 0; i < (chromaFormat === 3 ? 12 : 8); i++) {
          if (raw[off >> 3]! & (1 << (7 - (off & 7)))) {
            off += 1;
            for (let j = 0; j < (i < 6 ? 16 : 64); j++) {
              off += this.expGolombSkip(raw, off);
            }
          } else {
            off += 1;
          }
        }
      }
    }
    off += this.expGolombSkip(raw, off);
    const pocType = this.expGolombRead(raw, off); off += this.expGolombSkip(raw, off);
    if (pocType === 0) {
      off += this.expGolombSkip(raw, off);
    } else if (pocType === 1) {
      off += 1;
      off += this.expGolombSkip(raw, off);
      off += this.expGolombSkip(raw, off);
      const numRef = this.expGolombRead(raw, off); off += this.expGolombSkip(raw, off);
      for (let i = 0; i < numRef; i++) {
        off += this.expGolombSkip(raw, off);
      }
    }
    off += this.expGolombSkip(raw, off);
    off += 1;
    const widthMbs = this.expGolombRead(raw, off) + 1; off += this.expGolombSkip(raw, off);
    const heightMaps = this.expGolombRead(raw, off) + 1; off += this.expGolombSkip(raw, off);
    const frameMbsOnly = (raw[off >> 3]! >> (7 - (off & 7))) & 1;

    this.width = widthMbs * 16;
    this.height = heightMaps * 16 * (2 - frameMbsOnly);
  }

  // ==================== HEVC fMP4 构建 ====================

  private buildHevcInitSegment(): Buffer | null {
    if (!this.vps || !this.sps || !this.pps) return null;

    const ftyp = this.box("ftyp",
      Buffer.from("isom", "ascii"),
      this.u32(0x200),
      Buffer.from("isomiso6hvc1mp41", "ascii"),
    );

    const hvcC = this.buildHvcC(this.vps, this.sps, this.pps);
    const sampleEntry = this.buildVisualSampleEntry("hvc1", hvcC);
    const moov = this.buildMoov(sampleEntry);

    return Buffer.concat([ftyp, moov]);
  }

  /** 构建 hvcC box（HEVC decoder configuration record） */
  private buildHvcC(vps: Buffer, sps: Buffer, pps: Buffer): Buffer {
    const rawVps = this.removeEmulationPrevention(vps);
    const rawSps = this.removeEmulationPrevention(sps);
    const rawPps = this.removeEmulationPrevention(pps);

    /** HEVCDecoderConfigurationRecord 最小 23 字节 + NAL 单元 */
    const nalUnitSize = 6 + 2 + rawVps.length + 2 + rawSps.length + 2 + rawPps.length;
    const data = Buffer.alloc(23 + nalUnitSize);
    let off = 0;

    data[off++] = 1;                        /** configurationVersion */
    /**
     * HEVC SPS layout (after start code):
     * [0-1] NAL header (2 bytes)
     * [2]   sps_video_parameter_set_id(4b) + sps_max_sub_layers_minus1(3b) + sps_temporal_id_nesting_flag(1b)
     * [3-14] profile_tier_level general part (12 bytes)
     *   [3]    general_profile_space(2b) + general_tier_flag(1b) + general_profile_idc(5b)
     *   [4-7]  general_profile_compatibility_flags (32b)
     *   [8-13] general_constraint_indicator_flags (48b)
     *   [14]   general_level_idc (8b)
     */
    /** general_profile_space(2) + general_tier_flag(1) + general_profile_idc(5) */
    data[off++] = rawSps[3]!;
    /** general_profile_compatibility_flags (4 bytes) */
    data[off++] = rawSps[4]!;
    data[off++] = rawSps[5]!;
    data[off++] = rawSps[6]!;
    data[off++] = rawSps[7]!;
    /** general_constraint_indicator_flags (6 bytes) */
    if (rawSps.length > 13) {
      data[off++] = rawSps[8]!;
      data[off++] = rawSps[9]!;
      data[off++] = rawSps[10]!;
      data[off++] = rawSps[11]!;
      data[off++] = rawSps[12]!;
      data[off++] = rawSps[13]!;
    } else {
      off += 6;
    }
    /** general_level_idc */
    data[off++] = rawSps.length > 14 ? rawSps[14]! : 0;
    /** min_spatial_segmentation_idc (4 reserved + 12 bits) */
    data.writeUInt16BE(0xF000, off); off += 2;
    /** parallelismType (6 reserved + 2 bits) */
    data[off++] = 0xFC;
    /** chromaFormat (6 reserved + 2 bits) */
    data[off++] = 0xFC;
    /** bitDepthLumaMinus8 (5 reserved + 3 bits) */
    data[off++] = 0xF8;
    /** bitDepthChromaMinus8 (5 reserved + 3 bits) */
    data[off++] = 0xF8;
    /** avgFrameRate */
    data.writeUInt16BE(0, off); off += 2;
    /** constantFrameRate(2) + numTemporalLayers(3) + temporalIdNested(1) + lengthSizeMinusOne(2) */
    const maxSubLayers = ((rawSps[2]! >> 1) & 0x07) + 1;
    const temporalIdNested = rawSps[2]! & 0x01;
    data[off++] = (0 << 6) | ((maxSubLayers & 0x07) << 3) | (temporalIdNested << 2) | 0x03; /** lengthSizeMinusOne=3 */
    /** numOfArrays */
    data[off++] = 3;    /** VPS + SPS + PPS */

    /** VPS array */
    data[off++] = 0xA0;  /** array_completeness=1 + NAL_unit_type=32 (VPS) */
    data.writeUInt16BE(1, off); off += 2; /** numNalus=1 */
    data.writeUInt16BE(rawVps.length, off); off += 2;
    rawVps.copy(data, off); off += rawVps.length;

    /** SPS array */
    data[off++] = 0xA1;  /** array_completeness=1 + NAL_unit_type=33 (SPS) */
    data.writeUInt16BE(1, off); off += 2;
    data.writeUInt16BE(rawSps.length, off); off += 2;
    rawSps.copy(data, off); off += rawSps.length;

    /** PPS array */
    data[off++] = 0xA2;  /** array_completeness=1 + NAL_unit_type=34 (PPS) */
    data.writeUInt16BE(1, off); off += 2;
    data.writeUInt16BE(rawPps.length, off); off += 2;
    rawPps.copy(data, off); off += rawPps.length;

    return this.box("hvcC", data.subarray(0, off));
  }

  private extractHevcCodec(): string {
    if (!this.sps || this.sps.length < 15) return "hvc1.1.6.L93.B0";
    /** 必须先移除防竞争字节再读取 profile_tier_level */
    const raw = this.removeEmulationPrevention(this.sps);
    if (raw.length < 15) return "hvc1.1.6.L93.B0";
    const profileSpace = (raw[3]! >> 6) & 3;
    const profileIdc = raw[3]! & 0x1f;
    const levelIdc = raw[14]!;
    const spacePrefix = profileSpace === 0 ? "" : String.fromCharCode("A".charCodeAt(0) + profileSpace - 1);
    return `hvc1${spacePrefix}.${profileIdc}.L${levelIdc}.B0`;
  }

  /** 简化 HEVC SPS 宽高解析 */
  private parseHevcSpsDimensions(sps: Buffer): void {
    const raw = this.removeEmulationPrevention(sps);
    /** HEVC SPS: NAL header(2) + sps_video_parameter_set_id(4) + ... */
    let off = 2 * 8;
    /** sps_video_parameter_set_id (4 bits) */
    off += 4;
    /** sps_max_sub_layers_minus1 (3 bits) */
    const maxSubLayers = ((raw[off >> 3]! >> (7 - (off & 7) - 2)) & 7) + 1;
    off += 3;
    /** sps_temporal_id_nesting_flag (1 bit) */
    off += 1;
    /** profile_tier_level (复杂，需要跳过） */
    /** general_profile_space(2) + general_tier_flag(1) + general_profile_idc(5) = 1 byte */
    off += 8;
    /** general_profile_compatibility_flags (4 bytes) */
    off += 32;
    /** general_constraint_indicator_flags (6 bytes) */
    off += 48;
    /** general_level_idc (1 byte) */
    off += 8;
    /** sub-layer profile present flags (每个 2 bytes) */
    for (let i = 0; i < maxSubLayers - 1; i++) {
      off += 2; /** std_sub_layer_profile_present_flag + sub_layer_level_present_flag */
    }
    /** 如果 maxSubLayers > 1，需要对齐字节 */
    if (maxSubLayers > 1) {
      for (let i = maxSubLayers - 1; i < 8; i++) {
        off += 2;
      }
    }

    /** 到了 sps_seq_parameter_set_id */
    off += this.expGolombSkip(raw, off);
    /** chroma_format_idc */
    const chromaFormat = this.expGolombRead(raw, off); off += this.expGolombSkip(raw, off);
    if (chromaFormat === 3) off += 1; /** separate_colour_plane_flag */
    /** pic_width_in_luma_samples */
    this.width = this.expGolombRead(raw, off); off += this.expGolombSkip(raw, off);
    /** pic_height_in_luma_samples */
    this.height = this.expGolombRead(raw, off); off += this.expGolombSkip(raw, off);

    /** conformance_window_flag - 如果有则需要调整 */
    const confWin = (raw[off >> 3]! >> (7 - (off & 7))) & 1;
    off += 1;
    if (confWin) {
      /** 跳过 4 个 exp-golomb 值 */
      for (let i = 0; i < 4; i++) {
        off += this.expGolombSkip(raw, off);
      }
    }
  }

  // ==================== 通用 fMP4 构建 ====================

  /** 构建视频 sample entry（avc1/hvc1 通用） */
  private buildVisualSampleEntry(type: string, configBox: Buffer): Buffer {
    const w = this.width || 1920;
    const h = this.height || 1080;

    const data = Buffer.alloc(78 + configBox.length);
    let off = 0;
    data.fill(0, off, off + 6); off += 6;
    data.writeUInt16BE(1, off); off += 2;
    off += 2;
    off += 2;
    off += 12;
    data.writeUInt16BE(w, off); off += 2;
    data.writeUInt16BE(h, off); off += 2;
    data.writeUInt32BE(0x00480000, off); off += 4;
    data.writeUInt32BE(0x00480000, off); off += 4;
    off += 4;
    data.writeUInt16BE(1, off); off += 2;
    off += 32;
    data.writeUInt16BE(0x0018, off); off += 2;
    data.writeInt16BE(-1, off); off += 2;
    configBox.copy(data, off);

    return this.box(type, data);
  }

  private buildMoov(sampleEntry: Buffer): Buffer {
    const w = this.width || 1920;
    const h = this.height || 1080;

    const mvhd = this.buildMvhd();
    const tkhd = this.buildTkhd(w, h);
    const mdhd = this.buildMdhd();
    const hdlr = this.buildHdlr();
    const vmhd = this.buildVmhd();
    const dinf = this.buildDinf();
    const stbl = this.buildStbl(sampleEntry);
    const minf = this.box("minf", Buffer.concat([vmhd, dinf, stbl]));
    const mdia = this.box("mdia", Buffer.concat([mdhd, hdlr, minf]));
    const trak = this.box("trak", Buffer.concat([tkhd, mdia]));
    const trex = this.buildTrex();
    const mvex = this.box("mvex", trex);

    return this.box("moov", Buffer.concat([mvhd, trak, mvex]));
  }

  private buildMvhd(): Buffer {
    const data = Buffer.alloc(100);
    data.writeUInt32BE(1000, 8);
    data.writeUInt32BE(0x00010000, 20);
    data.writeUInt16BE(0x0100, 24);
    data.writeUInt32BE(0x00010000, 36);
    data.writeUInt32BE(0x00010000, 52);
    data.writeUInt32BE(0x40000000, 68);
    data.writeUInt32BE(2, 96);
    return this.box("mvhd", data);
  }

  private buildTkhd(w: number, h: number): Buffer {
    const data = Buffer.alloc(84);
    data.writeUInt32BE(1, 0);           /** flags=1 (track enabled) */
    data.writeUInt32BE(1, 12);          /** track_id=1 */
    data.writeUInt32BE(0x00010000, 36); /** matrix[0] */
    data.writeUInt32BE(0x00010000, 52); /** matrix[4] */
    data.writeUInt32BE(0x40000000, 68); /** matrix[8] */
    data.writeUInt32BE(w << 16, 76);    /** width 16.16 */
    data.writeUInt32BE(h << 16, 80);    /** height 16.16 */
    return this.box("tkhd", data);
  }

  private buildMdhd(): Buffer {
    const data = Buffer.alloc(20);
    data.writeUInt32BE(90000, 4);
    return this.box("mdhd", data);
  }

  private buildHdlr(): Buffer {
    const name = Buffer.from("VideoHandler\0", "ascii");
    const data = Buffer.concat([
      Buffer.alloc(4),
      Buffer.from("vide", "ascii"),
      Buffer.alloc(12),
      name,
    ]);
    return this.box("hdlr", data);
  }

  private buildVmhd(): Buffer {
    const data = Buffer.alloc(12);
    data.writeUInt32BE(1, 0);
    return this.box("vmhd", data);
  }

  private buildDinf(): Buffer {
    const urlEntry = Buffer.alloc(12);
    urlEntry.writeUInt32BE(12, 0);
    urlEntry.write("url ", 4, 4, "ascii");
    urlEntry.writeUInt32BE(1, 8);

    const dref = Buffer.concat([
      Buffer.alloc(8),
      urlEntry,
    ]);
    dref.writeUInt32BE(1, 4);

    return this.box("dinf", this.box("dref", dref));
  }

  private buildStbl(sampleEntry: Buffer): Buffer {
    const stsd = this.box("stsd", Buffer.concat([Buffer.from([0, 0, 0, 1]), sampleEntry]));
    const stts = this.box("stts", Buffer.alloc(8));
    const stsc = this.box("stsc", Buffer.alloc(8));
    const stsz = this.box("stsz", Buffer.alloc(12));
    const stco = this.box("stco", Buffer.alloc(8));
    return this.box("stbl", Buffer.concat([stsd, stts, stsc, stsz, stco]));
  }

  private buildTrex(): Buffer {
    const data = Buffer.alloc(24);
    data.writeUInt32BE(1, 0);
    data.writeUInt32BE(1, 4);
    return this.box("trex", data);
  }

  /** 发送当前 segment */
  private flushSegment(eventBus: EventBus, cameraId: string): void {
    if (this.segmentFrames.length === 0) return;
    if (!this.initSent) {
      this.segmentFrames = [];
      this.segmentFrameSizes = [];
      this.segmentFrameFlags = [];
      this.segmentHasIdr = false;
      return;
    }

    this.sequenceNumber++;
    const moofMdat = this.buildMediaSegment();
    if (moofMdat) {
      /** 缓存最近 media segment（新客户端快速显示首帧） */
      this.lastMediaData = moofMdat;
      eventBus.emit("fmp4:segment", { cameraId, data: moofMdat });
    }

    this.segmentFrames = [];
    this.segmentFrameSizes = [];
    this.segmentFrameFlags = [];
  }

  /** 构建 media segment (moof + mdat) */
  private buildMediaSegment(): Buffer | null {
    if (this.segmentFrames.length === 0) return null;

    const mdatPayload = Buffer.concat(this.segmentFrames);
    const mdat = this.box("mdat", mdatPayload);

    const mfhd = this.box("mfhd", this.u32(this.sequenceNumber));

    const tfhdData = Buffer.alloc(8);
    tfhdData.writeUInt32BE(1, 0);
    const tfhd = this.fullBox("tfhd", 0x020000, tfhdData);

    const tfdtDataV1 = Buffer.alloc(8);
    tfdtDataV1.writeBigUInt64BE(BigInt(this.segmentStartDts), 0);
    const tfdt = this.fullBox("tfdt", 0, tfdtDataV1, 1);

    const sampleCount = this.segmentFrames.length;
    const trunFlags = 0x000F01;
    const trunDataSize = 4 + 4 + sampleCount * 12;
    const trunData = Buffer.alloc(trunDataSize);
    let off = 0;
    trunData.writeUInt32BE(sampleCount, off); off += 4;
    off += 4;

    for (let i = 0; i < sampleCount; i++) {
      trunData.writeUInt32BE(this.frameDuration, off); off += 4;
      trunData.writeUInt32BE(this.segmentFrameSizes[i]!, off); off += 4;
      trunData.writeUInt32BE(this.segmentFrameFlags[i]! ? 0x00000000 : 0x01010000, off); off += 4;
    }
    const trun = this.fullBox("trun", trunFlags, trunData);

    const traf = this.box("traf", Buffer.concat([tfhd, tfdt, trun]));
    const moof = this.box("moof", Buffer.concat([mfhd, traf]));

    const moofSize = moof.length;
    const dataOffsetPos = moof.length - trun.length + 12 + 4;
    moof.writeUInt32BE(moofSize + 8, dataOffsetPos);

    return Buffer.concat([moof, mdat]);
  }

  // ==================== 工具方法 ====================

  private removeEmulationPrevention(nal: Buffer): Buffer {
    const result: number[] = [];
    let i = 0;
    while (i < nal.length) {
      if (i + 2 < nal.length && nal[i] === 0 && nal[i + 1] === 0 && nal[i + 2] === 3) {
        result.push(0, 0);
        i += 3;
      } else {
        result.push(nal[i]!);
        i++;
      }
    }
    return Buffer.from(result);
  }

  private expGolombRead(buf: Buffer, bitOffset: number): number {
    let leadingZeros = 0;
    while (bitOffset < buf.length * 8) {
      const byteIdx = bitOffset >> 3;
      const bitIdx = 7 - (bitOffset & 7);
      if (((buf[byteIdx]! >> bitIdx) & 1) === 0) {
        leadingZeros++;
        bitOffset++;
      } else {
        break;
      }
    }
    bitOffset++;
    let value = 1;
    for (let i = 0; i < leadingZeros; i++) {
      const byteIdx = bitOffset >> 3;
      const bitIdx = 7 - (bitOffset & 7);
      value = (value << 1) | ((buf[byteIdx]! >> bitIdx) & 1);
      bitOffset++;
    }
    return value - 1;
  }

  private expGolombSkip(buf: Buffer, bitOffset: number): number {
    const len = this.expGolombRead(buf, bitOffset);
    const bits = len === 0 ? 1 : Math.floor(Math.log2(len + 1)) + 1;
    return bits * 2 - 1;
  }

  private parseExpGolomb(buf: Buffer, byteOffset: number): number {
    if (byteOffset >= buf.length) return 0;
    return this.expGolombRead(buf, byteOffset * 8);
  }

  private box(type: string, ...parts: Buffer[]): Buffer {
    const payload = Buffer.concat(parts);
    const header = Buffer.alloc(8);
    header.writeUInt32BE(8 + payload.length, 0);
    header.write(type, 4, 4, "ascii");
    return Buffer.concat([header, payload]);
  }

  private fullBox(type: string, flags: number, data: Buffer, version: number = 0): Buffer {
    const vf = Buffer.alloc(4);
    /** version(1 byte) + flags(3 bytes) = 4 bytes */
    vf.writeUInt32BE((version << 24) | (flags & 0x00FFFFFF), 0);
    return this.box(type, vf, data);
  }

  private u32(v: number): Buffer {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(v, 0);
    return b;
  }
}

/**
 * 视频 RTSP → fMP4 流提取器
 * 自动检测 H.264/HEVC 码流，零转码封装为 fMP4 段
 * 单个 ffmpeg 进程，CPU 开销极低
 */
export class H264Fmp4Extractor {
  private proc: ReturnType<typeof spawn> | null = null;
  private muxer = new VideoToFmp4Muxer();
  private running = false;
  private online = false;
  private retryCount = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private logTag: string;
  /** 缓存 init segment（新客户端连接时发送） */
  private cachedInit: Fmp4InitSegment | null = null;

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
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.online = false;
    this.killProcess();
  }

  get isOnline(): boolean { return this.online; }

  get fps(): number { return this.muxer.fps; }

  get initSegment(): Fmp4InitSegment | null { return this.cachedInit; }

  /** 获取缓存的最近 media segment（新客户端连接时立即显示画面） */
  get lastMediaSegment(): Buffer | null { return this.muxer.lastMediaSegment; }

  get lastFrameAt(): number { return this.online ? Date.now() : 0; }

  /** 当前尝试的码流格式 */
  private tryFormat: "hevc" | "avc" = "hevc";

  private spawnFfmpeg(): void {
    /** 根据上次尝试结果选择格式 */
    const isHevc = this.tryFormat === "hevc";
    const format = isHevc ? "hevc" : "h264";
    const bsf = isHevc ? "hevc_mp4toannexb" : "h264_mp4toannexb";

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
      "-f", format,
      "-bsf:v", bsf,
      "pipe:1",
    ];

    console.log(`${this.logTag} 启动 ffmpeg (${format}): ${this.ffmpegPath} ${args.join(" ")}`);

    this.proc = spawn(this.ffmpegPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.proc.stdout?.on("data", (chunk: Buffer) => {
      this.muxer.feed(chunk, this.eventBus, this.config.id);

      const init = this.muxer.lastInitSegment;
      if (init) {
        this.cachedInit = init;
      }

      if (!this.online) {
        this.online = true;
        console.log(`${this.logTag} 流上线 (codec=${this.muxer.detectedCodec ?? "unknown"})`);
      }
      this.retryCount = 0;
    });

    let bsfError = false;

    this.proc.stderr?.on("data", (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg.includes("error") || msg.includes("Error")) {
        console.error(`${this.logTag} ffmpeg error:`, msg);
        if (msg.includes("not supported by the bitstream filter")) {
          bsfError = true;
        }
      }
    });

    this.proc.on("exit", (code) => {
      console.log(`${this.logTag} ffmpeg 退出, code=${code}`);
      this.muxer.flushRemaining(this.eventBus, this.config.id);
      this.online = false;
      this.muxer.reset();
      /** bsf 不匹配时切换格式重试 */
      if (bsfError && code !== 0) {
        this.tryFormat = this.tryFormat === "hevc" ? "avc" : "hevc";
        console.log(`${this.logTag} bsf 不匹配，切换到 ${this.tryFormat} 格式`);
      }
      this.scheduleReconnect();
    });
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
