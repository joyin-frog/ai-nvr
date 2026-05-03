import { type Fmp4InitSegment } from "@/camera/h264-fmp4-muxer";

/** fMP4 环形缓冲区中的一个 segment 条目 */
interface Fmp4SegmentEntry {
  /** moof box 数据 */
  moofData: Buffer;
  /** mdat box 数据 */
  mdatData: Buffer;
  /** 收到此 segment 的时间 (Date.now()) */
  timestamp: number;
  /** 此条目的字节大小 (moof + mdat) */
  byteSize: number;
}

/**
 * fMP4 segment 环形缓冲区
 * 内存中保留最近 maxBytes 字节的 fMP4 media segments，
 * 事件触发时 flush 或 snapshot 取出预缓冲数据用于录像落盘。
 */
export class Fmp4RingBuffer {
  private entries: Array<Fmp4SegmentEntry | null>;
  private head = 0;
  private tail = 0;
  private count = 0;
  /** 缓冲区中所有 segment 的总字节大小 */
  private totalBytes = 0;
  /** 最大字节容量 */
  private maxBytes: number;
  /** 缓存的 init segment（与 media segments 绑定，ffmpeg 重连时刷新） */
  private _initSegment: Fmp4InitSegment | null = null;

  constructor(maxBytes: number = 8 * 1024 * 1024) {
    this.maxBytes = maxBytes;
    this.entries = new Array(256).fill(null);
  }

  /** 更新 init segment（收到新的 fmp4:init 时调用） */
  setInitSegment(init: Fmp4InitSegment): void {
    /** init segment 变化说明 ffmpeg 重连了，旧 media segments 不再兼容 */
    const changed = this._initSegment !== null && this._initSegment.data !== init.data;
    this._initSegment = init;
    if (changed) {
      this.clear();
    }
  }

  /** 获取当前 init segment */
  get initSegment(): Fmp4InitSegment | null {
    return this._initSegment;
  }

  /** O(1) 追加一个 segment */
  push(moofData: Buffer, mdatData: Buffer, timestamp: number): void {
    const byteSize = moofData.length + mdatData.length;

    /** 淘汰旧 segment 直到容量足够 */
    while (this.count > 0 && this.totalBytes + byteSize > this.maxBytes) {
      this.evictOldest();
    }

    /** 动态扩容数组 */
    if (this.count >= this.entries.length) {
      this.grow();
    }

    this.entries[this.tail] = { moofData, mdatData, timestamp, byteSize };
    this.tail = (this.tail + 1) % this.entries.length;
    this.count++;
    this.totalBytes += byteSize;
  }

  /** 取出全部 segments 并清空缓冲区（用于 motion 模式预缓冲 drain） */
  drain(): { initSegment: Fmp4InitSegment; segments: Fmp4SegmentEntry[] } | null {
    if (this.count === 0 || !this._initSegment) return null;

    const segments: Fmp4SegmentEntry[] = [];
    for (let i = 0; i < this.count; i++) {
      const entry = this.entries[(this.head + i) % this.entries.length]!;
      segments.push(entry);
    }
    const init = this._initSegment;

    /** 清空 */
    for (let i = 0; i < this.count; i++) {
      this.entries[(this.head + i) % this.entries.length] = null;
    }
    this.head = 0;
    this.tail = 0;
    this.count = 0;
    this.totalBytes = 0;

    return { initSegment: init, segments };
  }

  /** 取出指定时间之后的所有 segments（拷贝，不清空） */
  snapshotFrom(afterTimestamp: number): { initSegment: Fmp4InitSegment; segments: Fmp4SegmentEntry[] } | null {
    if (this.count === 0 || !this._initSegment) return null;

    const segments: Fmp4SegmentEntry[] = [];
    for (let i = 0; i < this.count; i++) {
      const entry = this.entries[(this.head + i) % this.entries.length]!;
      if (entry.timestamp > afterTimestamp) {
        for (let j = i; j < this.count; j++) {
          segments.push(this.entries[(this.head + j) % this.entries.length]!);
        }
        return { initSegment: this._initSegment, segments };
      }
    }
    return { initSegment: this._initSegment, segments: [] };
  }

  /** 清空缓冲区（保留 init segment） */
  clear(): void {
    for (let i = 0; i < this.count; i++) {
      this.entries[(this.head + i) % this.entries.length] = null;
    }
    this.head = 0;
    this.tail = 0;
    this.count = 0;
    this.totalBytes = 0;
  }

  /** 当前缓冲的 segment 数量 */
  get length(): number {
    return this.count;
  }

  /** 当前缓冲的总字节大小 */
  get bytes(): number {
    return this.totalBytes;
  }

  /** 调整最大字节容量 */
  resize(maxBytes: number): void {
    this.maxBytes = maxBytes;
    while (this.count > 0 && this.totalBytes > maxBytes) {
      this.evictOldest();
    }
  }

  /** 淘汰最旧的一个 segment */
  private evictOldest(): void {
    if (this.count === 0) return;
    const entry = this.entries[this.head]!;
    this.totalBytes -= entry.byteSize;
    this.entries[this.head] = null;
    this.head = (this.head + 1) % this.entries.length;
    this.count--;
  }

  /** 动态扩容环形数组 */
  private grow(): void {
    const newSize = this.entries.length * 2;
    const newEntries = new Array<Fmp4SegmentEntry | null>(newSize).fill(null);
    for (let i = 0; i < this.count; i++) {
      newEntries[i] = this.entries[(this.head + i) % this.entries.length] ?? null;
    }
    this.entries = newEntries;
    this.head = 0;
    this.tail = this.count;
  }
}
