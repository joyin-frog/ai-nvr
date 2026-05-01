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

/** NAL unit type 常量 */
const NAL_TYPE_NON_IDR = 1;
const NAL_TYPE_IDR = 5;
const NAL_TYPE_SPS = 7;
const NAL_TYPE_PPS = 8;

/**
 * H.264 Annex B → fMP4 转换器
 * 从 ffmpeg stdout 接收 H.264 裸流，解析 NAL 单元并封装为 fMP4 段
 * 零转码（-c:v copy），CPU 开销极低
 */
class H264ToFmp4Muxer {
  /** 未处理的缓冲区 */
  private buffer = Buffer.alloc(0);
  /** 已提取但未分组的 NAL 单元 */
  private pendingNals: Buffer[] = [];
  /** 上一个 VCL NAL 的类型（用于检测 access unit 边界） */
  private lastVclType = -1;
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

  /** 帧持续时间（90kHz），默认 30fps = 3000 ticks/frame */
  private frameDuration = 3000;

  /** 当前 segment 中累积的帧 */
  private segmentFrames: Buffer[] = [];
  /** 当前 segment 的起始 DTS */
  private segmentStartDts = 0;
  /** 当前 segment 中每帧的大小（用于 trun） */
  private segmentFrameSizes: number[] = [];
  /** 当前 segment 中每帧是否关键帧 */
  private segmentFrameFlags: boolean[] = [];

  feed(data: Buffer, eventBus: EventBus, cameraId: string): void {
    this.buffer = Buffer.concat([this.buffer, data]);
    this.extractNals(eventBus, cameraId);
  }

  /** 提取 NAL 单元 */
  private extractNals(eventBus: EventBus, cameraId: string): void {
    while (this.buffer.length >= 4) {
      /** 搜索起始码 00 00 00 01 或 00 00 01 */
      let startCodeLen = 0;
      let nalStart = -1;

      for (let i = 0; i <= this.buffer.length - 4; i++) {
        if (this.buffer[i] === 0 && this.buffer[i + 1] === 0) {
          if (this.buffer[i + 2] === 1) {
            startCodeLen = 3;
            nalStart = i;
            break;
          } else if (this.buffer[i + 2] === 0 && i + 3 < this.buffer.length && this.buffer[i + 3] === 1) {
            startCodeLen = 4;
            nalStart = i;
            break;
          }
        }
      }

      if (nalStart === -1) {
        /** 没有找到起始码，保留末尾 3 字节防止截断 */
        if (this.buffer.length > 3) {
          this.buffer = this.buffer.subarray(this.buffer.length - 3);
        }
        return;
      }

      /** 找下一个起始码 */
      let nextStart = -1;
      let nextStartLen = 0;
      for (let i = nalStart + startCodeLen; i <= this.buffer.length - 3; i++) {
        if (this.buffer[i] === 0 && this.buffer[i + 1] === 0) {
          if (this.buffer[i + 2] === 1) {
            nextStart = i;
            nextStartLen = 3;
            break;
          } else if (this.buffer[i + 2] === 0 && i + 3 < this.buffer.length && this.buffer[i + 3] === 1) {
            nextStart = i;
            nextStartLen = 4;
            break;
          }
        }
      }

      if (nextStart === -1) {
        /** 不完整的 NAL，等待更多数据 */
        if (nalStart > 0) {
          this.buffer = this.buffer.subarray(nalStart);
        }
        return;
      }

      /** 提取 NAL 数据（不含起始码） */
      const nalData = Buffer.from(this.buffer.subarray(nalStart + startCodeLen, nextStart));
      this.buffer = this.buffer.subarray(nextStart);

      this.processNal(nalData, eventBus, cameraId);
    }
  }

  /** 处理单个 NAL 单元 */
  private processNal(nal: Buffer, eventBus: EventBus, cameraId: string): void {
    if (nal.length === 0) return;
    const nalType = nal[0]! & 0x1f;

    if (nalType === NAL_TYPE_SPS) {
      this.sps = nal;
      this.parseSpsDimensions(nal);
      /** SPS 属于下一个 access unit */
      this.flushAccessUnit(eventBus, cameraId);
      this.pendingNals.push(nal);
    } else if (nalType === NAL_TYPE_PPS) {
      this.pps = nal;
      this.pendingNals.push(nal);
    } else if (nalType === NAL_TYPE_IDR) {
      this.flushAccessUnit(eventBus, cameraId);
      this.pendingNals.push(nal);
      this.lastVclType = NAL_TYPE_IDR;
    } else if (nalType === NAL_TYPE_NON_IDR) {
      /** 检测 access unit 边界：first_mb_in_slice == 0 表示新帧 */
      const firstMb = this.parseExpGolomb(nal, 1);
      if (firstMb === 0 && this.lastVclType >= 0) {
        this.flushAccessUnit(eventBus, cameraId);
      }
      this.pendingNals.push(nal);
      this.lastVclType = NAL_TYPE_NON_IDR;
    }
    /** 忽略其他 NAL 类型（SEI 等） */
  }

  /** 完成一个 access unit（帧） */
  private flushAccessUnit(eventBus: EventBus, cameraId: string): void {
    if (this.pendingNals.length === 0) return;

    /** 检查是否有 VCL NAL */
    const hasVcl = this.pendingNals.some(n => {
      const t = n[0]! & 0x1f;
      return t === NAL_TYPE_IDR || t === NAL_TYPE_NON_IDR;
    });
    if (!hasVcl) {
      this.pendingNals = [];
      this.lastVclType = -1;
      return;
    }

    /** 判断是否是 IDR 帧 */
    const isIdr = this.pendingNals.some(n => (n[0]! & 0x1f) === NAL_TYPE_IDR);

    /** 如果需要发送 init segment */
    if (isIdr && this.sps && this.pps) {
      const initSegment = this.buildInitSegment();
      if (initSegment) {
        const codec = this.extractCodec();
        const init: Fmp4InitSegment = { type: "init" as const, codec, data: initSegment };
        this.lastInit = init;
        eventBus.emit("fmp4:init", { cameraId, segment: init });
        this.initSent = true;
      }
    }

    /** 将 NAL 从 Annex B 转为 AVCC 格式 */
    const avccData = this.nalsToAvcc(this.pendingNals);
    const frameSize = avccData.length;

    /** IDR 帧触发 segment 发送 */
    if (isIdr && this.segmentFrames.length > 0) {
      this.flushSegment(eventBus, cameraId);
    }

    if (this.segmentFrames.length === 0) {
      this.segmentStartDts = this.nextDts;
    }

    this.segmentFrames.push(avccData);
    this.segmentFrameSizes.push(frameSize);
    this.segmentFrameFlags.push(isIdr);
    this.nextDts += this.frameDuration;

    /** FPS 统计 */
    this.frameCount++;
    const now = Date.now();
    if (now - this.frameCountStart >= 5000) {
      this.currentFps = this.frameCount * 1000 / (now - this.frameCountStart);
      this.frameCount = 0;
      this.frameCountStart = now;
    }

    this.pendingNals = [];
    this.lastVclType = -1;
  }

  get fps(): number { return this.currentFps; }

  /** 获取最近生成的 init segment */
  get lastInitSegment(): Fmp4InitSegment | null { return this.lastInit; }

  /** 强制发送当前缓冲的 segment */
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
    this.nextDts = 0;
    this.sequenceNumber = 0;
    this.frameCount = 0;
    this.frameCountStart = Date.now();
    this.currentFps = 0;
  }

  /** 将 NAL 数组转为 AVCC 格式（4字节长度前缀） */
  private nalsToAvcc(nals: Buffer[]): Buffer {
    const parts: Buffer[] = [];
    for (const nal of nals) {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(nal.length, 0);
      parts.push(len, nal);
    }
    return Buffer.concat(parts);
  }

  /** 构建 fMP4 init segment (ftyp + moov) */
  private buildInitSegment(): Buffer | null {
    if (!this.sps || !this.pps) return null;

    const ftyp = this.box("ftyp",
      Buffer.from("isom", "ascii"),                         /** major_brand */
      this.u32(0x200),                                      /** minor_version */
      Buffer.from("isomiso6avc1mp41", "ascii"),            /** compatible_brands */
    );

    const avcC = this.buildAvcC(this.sps, this.pps);
    const avc1 = this.buildAvc1(avcC);
    const moov = this.buildMoov(avc1);

    return Buffer.concat([ftyp, moov]);
  }

  /** 构建 avcC box */
  private buildAvcC(sps: Buffer, pps: Buffer): Buffer {
    /** 移除防竞争字节（仅用于 avcC） */
    const rawSps = this.removeEmulationPrevention(sps);
    const rawPps = this.removeEmulationPrevention(pps);

    const data = Buffer.alloc(11 + rawSps.length + rawPps.length);
    let off = 0;
    data[off++] = 1;                        /** configurationVersion */
    data[off++] = rawSps[1]!;              /** AVCProfileIndication */
    data[off++] = rawSps[2]!;              /** profile_compatibility */
    data[off++] = rawSps[3]!;              /** AVCLevelIndication */
    data[off++] = 0xFF;                     /** lengthSizeMinusOne=3 (4字节) + reserved */
    data[off++] = 0xE1;                     /** numOfSPS=1 + reserved */
    data.writeUInt16BE(rawSps.length, off); off += 2;
    rawSps.copy(data, off); off += rawSps.length;
    data[off++] = 1;                        /** numOfPPS=1 */
    data.writeUInt16BE(rawPps.length, off); off += 2;
    rawPps.copy(data, off);

    return this.box("avcC", data.subarray(0, off));
  }

  /** 构建 avc1 sample entry */
  private buildAvc1(avcC: Buffer): Buffer {
    const w = this.width || 1920;
    const h = this.height || 1080;

    const data = Buffer.alloc(78 + avcC.length);
    let off = 0;
    data.fill(0, off, off + 6); off += 6;   /** reserved */
    data.writeUInt16BE(1, off); off += 2;    /** data_reference_index */
    off += 2;                                /** pre_defined */
    off += 2;                                /** reserved */
    off += 12;                               /** pre_defined */
    data.writeUInt16BE(w, off); off += 2;    /** width */
    data.writeUInt16BE(h, off); off += 2;    /** height */
    data.writeUInt32BE(0x00480000, off); off += 4; /** horiz_resolution 72dpi */
    data.writeUInt32BE(0x00480000, off); off += 4; /** vert_resolution 72dpi */
    off += 4;                                /** reserved */
    data.writeUInt16BE(1, off); off += 2;    /** frame_count */
    off += 32;                               /** compressor_name */
    data.writeUInt16BE(0x0018, off); off += 2; /** depth */
    data.writeInt16BE(-1, off); off += 2;    /** pre_defined */
    avcC.copy(data, off);

    return this.box("avc1", data);
  }

  /** 构建 moov box */
  private buildMoov(avc1: Buffer): Buffer {
    const w = this.width || 1920;
    const h = this.height || 1080;

    const mvhd = this.buildMvhd();
    const tkhd = this.buildTkhd(w, h);
    const mdhd = this.buildMdhd();
    const hdlr = this.buildHdlr();
    const vmhd = this.buildVmhd();
    const dinf = this.buildDinf();
    const stbl = this.buildStbl(avc1);
    const minf = this.box("minf", Buffer.concat([vmhd, dinf, stbl]));
    const mdia = this.box("mdia", Buffer.concat([mdhd, hdlr, minf]));
    const trak = this.box("trak", Buffer.concat([tkhd, mdia]));
    const trex = this.buildTrex();
    const mvex = this.box("mvex", trex);

    return this.box("moov", Buffer.concat([mvhd, trak, mvex]));
  }

  private buildMvhd(): Buffer {
    const data = Buffer.alloc(100);
    let off = 0;
    off += 4; /** version + flags */
    off += 4; /** creation_time */
    off += 4; /** modification_time */
    data.writeUInt32BE(1000, off); off += 4; /** timescale */
    off += 4; /** duration */
    data.writeUInt32BE(0x00010000, off); off += 4; /** rate = 1.0 */
    data.writeUInt16BE(0x0100, off); off += 2;  /** volume = 1.0 */
    off += 10; /** reserved */
    /** identity matrix */
    data.writeUInt32BE(0x00010000, off); off += 4;
    off += 4;
    off += 4;
    off += 4;
    data.writeUInt32BE(0x00010000, off); off += 4;
    off += 4;
    off += 4;
    off += 4;
    data.writeUInt32BE(0x40000000, off); off += 4;
    off += 24; /** pre_defined */
    data.writeUInt32BE(2, off); /** next_track_id */
    return this.box("mvhd", data);
  }

  private buildTkhd(w: number, h: number): Buffer {
    const data = Buffer.alloc(80);
    let off = 4; /** version=0, flags=1 (track enabled) */
    data.writeUInt32BE(1, off - 4); /** flags */
    off += 4; /** creation_time */
    off += 4; /** modification_time */
    data.writeUInt32BE(1, off); off += 4; /** track_id */
    off += 4; /** reserved */
    off += 4; /** duration */
    off += 8; /** reserved */
    off += 2; /** layer */
    off += 2; /** alternate_group */
    off += 2; /** volume */
    off += 2; /** reserved */
    /** identity matrix */
    data.writeUInt32BE(0x00010000, off); off += 4;
    off += 4; off += 4; off += 4;
    data.writeUInt32BE(0x00010000, off); off += 4;
    off += 4; off += 4; off += 4;
    data.writeUInt32BE(0x40000000, off); off += 4;
    data.writeUInt32BE(w << 16, off); off += 4; /** width 16.16 */
    data.writeUInt32BE(h << 16, off); off += 4; /** height 16.16 */
    return this.box("tkhd", data);
  }

  private buildMdhd(): Buffer {
    const data = Buffer.alloc(20);
    data.writeUInt32BE(90000, 4); /** timescale = 90kHz */
    return this.box("mdhd", data);
  }

  private buildHdlr(): Buffer {
    const name = Buffer.from("VideoHandler\0", "ascii");
    const data = Buffer.concat([
      Buffer.alloc(4),                        /** pre_defined */
      Buffer.from("vide", "ascii"),           /** handler_type */
      Buffer.alloc(12),                       /** reserved */
      name,
    ]);
    return this.box("hdlr", data);
  }

  private buildVmhd(): Buffer {
    const data = Buffer.alloc(12);
    data.writeUInt32BE(1, 0); /** flags=1 */
    return this.box("vmhd", data);
  }

  private buildDinf(): Buffer {
    const urlEntry = Buffer.alloc(12);
    urlEntry.writeUInt32BE(12, 0);         /** size */
    urlEntry.write("url ", 4, 4, "ascii"); /** type */
    urlEntry.writeUInt32BE(1, 8);          /** flags=self-contained */

    const dref = Buffer.concat([
      Buffer.alloc(8),                       /** version + flags + entry_count=1 */
      urlEntry,
    ]);
    dref.writeUInt32BE(1, 4); /** entry_count */

    return this.box("dinf", this.box("dref", dref));
  }

  private buildStbl(avc1: Buffer): Buffer {
    const stsd = this.box("stsd", Buffer.concat([Buffer.from([0, 0, 0, 1]), avc1]));
    const stts = this.box("stts", Buffer.alloc(8)); /** empty */
    const stsc = this.box("stsc", Buffer.alloc(8));
    const stsz = this.box("stsz", Buffer.alloc(12));
    const stco = this.box("stco", Buffer.alloc(8));
    return this.box("stbl", Buffer.concat([stsd, stts, stsc, stsz, stco]));
  }

  private buildTrex(): Buffer {
    const data = Buffer.alloc(24);
    data.writeUInt32BE(1, 0);   /** track_id */
    data.writeUInt32BE(1, 4);   /** default_sample_description_index */
    return this.box("trex", data);
  }

  /** 发送当前 segment */
  private flushSegment(eventBus: EventBus, cameraId: string): void {
    if (this.segmentFrames.length === 0) return;
    if (!this.initSent) {
      this.segmentFrames = [];
      this.segmentFrameSizes = [];
      this.segmentFrameFlags = [];
      return;
    }

    this.sequenceNumber++;
    const moofMdat = this.buildMediaSegment();
    if (moofMdat) {
      eventBus.emit("fmp4:segment", { cameraId, data: moofMdat });
    }

    this.segmentFrames = [];
    this.segmentFrameSizes = [];
    this.segmentFrameFlags = [];
  }

  /** 构建 media segment (moof + mdat) */
  private buildMediaSegment(): Buffer | null {
    if (this.segmentFrames.length === 0) return null;

    /** mdat payload */
    const mdatPayload = Buffer.concat(this.segmentFrames);
    const mdat = this.box("mdat", mdatPayload);

    /** 构建 moof */
    const mfhd = this.box("mfhd", this.u32(this.sequenceNumber));

    /** tfhd */
    const tfhdData = Buffer.alloc(8);
    tfhdData.writeUInt32BE(1, 0); /** track_id */
    const tfhd = this.fullBox("tfhd", 0x020000, tfhdData); /** default-base-is-moof */

    /** tfdt */
    const tfdtData = Buffer.alloc(8);
    tfdtData.writeUInt32BE(Math.floor(this.segmentStartDts / 90000 * 1000), 4); /** baseMediaDecodeTime (高32位) */
    /** 实际上用 version=1, 64-bit */
    const tfdtDataV1 = Buffer.alloc(8);
    tfdtDataV1.writeBigUInt64BE(BigInt(this.segmentStartDts), 0);
    const tfdt = this.fullBox("tfdt", 0, tfdtDataV1, 1);

    /** trun */
    const sampleCount = this.segmentFrames.length;
    const trunFlags = 0x000F01; /** data_offset + sample_duration + sample_size + sample_flags */
    const trunDataSize = 4 + 4 + sampleCount * 12; /** sample_count + data_offset + N*(duration+size+flags) */
    const trunData = Buffer.alloc(trunDataSize);
    let off = 0;
    trunData.writeUInt32BE(sampleCount, off); off += 4;
    /** data_offset 先写 0，后面修正 */
    off += 4;

    for (let i = 0; i < sampleCount; i++) {
      trunData.writeUInt32BE(this.frameDuration, off); off += 4; /** duration */
      trunData.writeUInt32BE(this.segmentFrameSizes[i]!, off); off += 4; /** size */
      trunData.writeUInt32BE(this.segmentFrameFlags[i]! ? 0x00000000 : 0x01010000, off); off += 4; /** flags: key vs non-key */
    }
    const trun = this.fullBox("trun", trunFlags, trunData);

    const traf = this.box("traf", Buffer.concat([tfhd, tfdt, trun]));
    const moof = this.box("moof", Buffer.concat([mfhd, traf]));

    /** 修正 data_offset = moof size + mdat header(8) */
    const moofSize = moof.length;
    const dataOffsetPos = moof.length - trun.length + 12 + 4; /** 定位 trun 内 data_offset 字段 */
    moof.writeUInt32BE(moofSize + 8, dataOffsetPos);

    return Buffer.concat([moof, mdat]);
  }

  /** 从 SPS 提取 codec 字符串 */
  private extractCodec(): string {
    if (!this.sps || this.sps.length < 4) return "avc1.42C01E";
    const profile = this.sps[1]!;
    const compat = this.sps[2]!;
    const level = this.sps[3]!;
    return `avc1.${profile.toString(16).padStart(2, "0")}${compat.toString(16).padStart(2, "0")}${level.toString(16).padStart(2, "0")}`;
  }

  /** 简化 SPS 解析：提取宽度高度 */
  private parseSpsDimensions(sps: Buffer): void {
    try {
      const raw = this.removeEmulationPrevention(sps);
      /** 跳过 NAL header (1) + profile (1) + compat (1) + level (1) */
      let off = 4;
      /** seq_parameter_set_id (Exp-Golomb) */
      off += this.expGolombSkip(raw, off);
      /** profile_idc 高级profile 的额外字段 */
      const profile = raw[1]!;
      if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
        /** chroma_format_idc */
        const chromaFormat = this.expGolombRead(raw, off); off += this.expGolombSkip(raw, off);
        if (chromaFormat === 3) off += 1; /** separate_colour_plane_flag */
        off += this.expGolombSkip(raw, off); /** bit_depth_luma_minus8 */
        off += this.expGolombSkip(raw, off); /** bit_depth_chroma_minus8 */
        off += 1; /** qpprime_y_zero_transform_bypass_flag */
        /** seq_scaling_matrix_present_flag */
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
      /** log2_max_frame_num_minus4 */
      off += this.expGolombSkip(raw, off);
      /** pic_order_cnt_type */
      const pocType = this.expGolombRead(raw, off); off += this.expGolombSkip(raw, off);
      if (pocType === 0) {
        off += this.expGolombSkip(raw, off); /** log2_max_pic_order_cnt_lsb_minus4 */
      } else if (pocType === 1) {
        off += 1; /** delta_pic_order_always_zero_flag */
        off += this.expGolombSkip(raw, off); /** offset_for_non_ref_pic */
        off += this.expGolombSkip(raw, off); /** offset_for_top_to_bottom_field */
        const numRef = this.expGolombRead(raw, off); off += this.expGolombSkip(raw, off);
        for (let i = 0; i < numRef; i++) {
          off += this.expGolombSkip(raw, off);
        }
      }
      off += this.expGolombSkip(raw, off); /** max_num_ref_frames */
      off += 1; /** gaps_in_frame_num_value_allowed_flag */
      /** pic_width_in_mbs_minus1 */
      const widthMbs = this.expGolombRead(raw, off) + 1; off += this.expGolombSkip(raw, off);
      /** pic_height_in_map_units_minus1 */
      const heightMaps = this.expGolombRead(raw, off) + 1; off += this.expGolombSkip(raw, off);
      /** frame_mbs_only_flag */
      const frameMbsOnly = (raw[off >> 3]! >> (7 - (off & 7))) & 1; off += 1;

      this.width = widthMbs * 16;
      this.height = heightMaps * 16 * (2 - frameMbsOnly);
    } catch {
      /** 解析失败不影响流输出 */
    }
  }

  /** 移除防竞争字节 */
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

  /** 读取 Exp-Golomb 无符号值 */
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
    bitOffset++; /** 跳过 '1' */
    let value = 1;
    for (let i = 0; i < leadingZeros; i++) {
      const byteIdx = bitOffset >> 3;
      const bitIdx = 7 - (bitOffset & 7);
      value = (value << 1) | ((buf[byteIdx]! >> bitIdx) & 1);
      bitOffset++;
    }
    return value - 1;
  }

  /** Exp-Golomb 值占用的位数 */
  private expGolombSkip(buf: Buffer, bitOffset: number): number {
    const len = this.expGolombRead(buf, bitOffset);
    const bits = len === 0 ? 1 : Math.floor(Math.log2(len + 1)) + 1;
    return bits * 2 - 1;
  }

  /** 解析 slice header 中的 first_mb_in_slice */
  private parseExpGolomb(buf: Buffer, byteOffset: number): number {
    if (byteOffset >= buf.length) return 0;
    let bitOffset = byteOffset * 8;
    return this.expGolombRead(buf, bitOffset);
  }

  /** Box 构建辅助 */
  private box(type: string, ...parts: Buffer[]): Buffer {
    const payload = Buffer.concat(parts);
    const header = Buffer.alloc(8);
    header.writeUInt32BE(8 + payload.length, 0);
    header.write(type, 4, 4, "ascii");
    return Buffer.concat([header, payload]);
  }

  /** Full box（带 version + flags） */
  private fullBox(type: string, flags: number, data: Buffer, version: number = 0): Buffer {
    const vf = Buffer.alloc(4);
    vf[0] = version;
    vf.writeUInt32BE(flags, 1);
    vf[0] = version; /** 确保版本号不被覆盖 */
    return this.box(type, vf, data);
  }

  private u32(v: number): Buffer {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(v, 0);
    return b;
  }
}

/**
 * H.264 RTSP → fMP4 流提取器
 * 从 RTSP 流提取 H.264 裸流（零转码 copy），封装为 fMP4 段
 * 单个 ffmpeg 进程，CPU 开销极低
 */
export class H264Fmp4Extractor {
  private proc: ReturnType<typeof spawn> | null = null;
  private muxer = new H264ToFmp4Muxer();
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
    this.logTag = `[H264-fMP4][${config.id}]`;
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

  /** 获取缓存的 init segment */
  get initSegment(): Fmp4InitSegment | null { return this.cachedInit; }

  /** 最近一帧时间（用在线时间近似） */
  get lastFrameAt(): number { return this.online ? Date.now() : 0; }

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
      "-f", "h264",
      "-bsf:v", "h264_mp4toannexb",
      "pipe:1",
    ];

    console.log(`${this.logTag} 启动 ffmpeg: ${this.ffmpegPath} ${args.join(" ")}`);

    this.proc = spawn(this.ffmpegPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.proc.stdout?.on("data", (chunk: Buffer) => {
      this.muxer.feed(chunk, this.eventBus, this.config.id);

      /** 缓存最新的 init segment */
      const init = this.muxer.lastInitSegment;
      if (init) {
        this.cachedInit = init;
      }

      if (!this.online) {
        this.online = true;
        console.log(`${this.logTag} 流上线`);
      }
      this.retryCount = 0;
    });

    this.proc.stderr?.on("data", (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg.includes("error") || msg.includes("Error")) {
        console.error(`${this.logTag} ffmpeg error:`, msg);
      }
    });

    this.proc.on("exit", (code) => {
      console.log(`${this.logTag} ffmpeg 退出, code=${code}`);
      this.muxer.flushRemaining(this.eventBus, this.config.id);
      this.online = false;
      this.muxer.reset();
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
