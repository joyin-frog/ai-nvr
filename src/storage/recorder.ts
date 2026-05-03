import { stat } from "node:fs/promises";
import { join } from "node:path";
import { type EventBus } from "@/event-bus";
import { type RuntimeConfig } from "@/runtime-config";
import { type Fmp4RingBuffer } from "@/storage/fmp4-ring-buffer";
import { Fmp4Writer } from "@/storage/fmp4-writer";
import { type StorageFs } from "@/storage/storage-fs";

/** 录像片段元信息 */
export interface RecordingInfo {
  /** 文件名 */
  filename: string;
  /** 摄像头 ID */
  cameraId: string;
  /** 开始时间（ms） */
  startTime: number;
  /** 结束时间（ms） */
  endTime: number;
  /** 文件大小（bytes） */
  size: number;
}

/** event 模式下触发录像的事件类型列表 */
const DEFAULT_EVENT_TRIGGERS = [
  "detect",
  "track:appeared",
  "track:enter-zone",
  "track:loiter",
  "track:line-cross",
  "alert",
];

/** 每个摄像头的录像状态 */
interface RecordingState {
  /** 是否正在录像 */
  recording: boolean;
  /** 当前录像开始时间 */
  startTime: number;
  /** 停止定时器 */
  stopTimer: ReturnType<typeof setTimeout> | null;
  /** 持续录制定时器（用于自动分段） */
  continuousTimer: ReturnType<typeof setTimeout> | null;
  /** fMP4 文件写入器 */
  writer: Fmp4Writer | null;
  /** 当前录像文件名 */
  filename: string;
  /** 录像中的 segment 数量（用于日志） */
  segmentCount: number;
  /** 录像累计时长（ms，通过 wall clock 估算） */
  recordedDurationMs: number;
  /** 最近一次写入 segment 的时间 */
  lastSegmentTime: number;
}

/**
 * 录像器（fMP4 环形缓冲 + 零转码落盘）
 *
 * 通过 EventBus 接收 fMP4 segments，环形缓冲在内存中，
 * 事件触发时从缓冲区取出 segments 拼接写入 MP4 文件。
 * 支持三种模式：motion（变动触发）/ continuous（持续录制）/ event（事件驱动）
 */
export class MotionRecorder {
  private states = new Map<string, RecordingState>();
  /** 摄像头 ID → 友好名称（水印用） */
  private cameraNames = new Map<string, string>();
  /** 存储目录 */
  private storagePath: string;
  /** ffmpeg 路径 */
  private ffmpegPath: string;
  /** 运行时配置 */
  private runtimeConfig: RuntimeConfig;
  /** fMP4 segment 事件取消订阅 */
  private unsubSegment: (() => void) | null = null;
  /** fMP4 init 事件取消订阅 */
  private unsubInit: (() => void) | null = null;
  /** motion 事件取消订阅 */
  private unsubMotion: (() => void) | null = null;
  /** event 模式事件取消订阅列表 */
  private unsubEvents: (() => void)[] = [];
  /** 过期录像清理定时器 */
  private purgeTimer: ReturnType<typeof setInterval> | null = null;
  /** 存储文件系统 */
  private storageFs: StorageFs;
  /** 每路摄像头的 fMP4 环形缓冲区 */
  private ringBuffers = new Map<string, Fmp4RingBuffer>();
  /** VLM 上下文帧缓冲（每摄像头最近几帧 JPEG，由 detect:frame 事件填充） */
  private contextFrameBuffers = new Map<string, Array<{ data: Buffer; timestamp: number }>>();
  /** detect:frame 事件取消订阅 */
  private unsubDetectFrame: (() => void) | null = null;

  constructor(storagePath: string, ffmpegPath: string, private eventBus: EventBus, runtimeConfig: RuntimeConfig, storageFs: StorageFs) {
    this.storagePath = storagePath;
    this.ffmpegPath = ffmpegPath;
    this.runtimeConfig = runtimeConfig;
    this.storageFs = storageFs;
  }

  /** 注册摄像头名称（水印用） */
  registerCameraName(cameraId: string, name: string): void {
    this.cameraNames.set(cameraId, name);
  }

  /** 移除摄像头 */
  unregisterStream(cameraId: string): void {
    this.forceStop(cameraId);
    this.ringBuffers.delete(cameraId);
    this.contextFrameBuffers.delete(cameraId);
    this.states.delete(cameraId);
  }

  /** 注入 fMP4 环形缓冲区（由 CameraManager 创建并注入） */
  setRingBuffer(cameraId: string, buf: Fmp4RingBuffer): void {
    this.ringBuffers.set(cameraId, buf);
  }

  /** 移除环形缓冲区 */
  removeRingBuffer(cameraId: string): void {
    this.ringBuffers.delete(cameraId);
  }

  /** 启动：订阅事件 + 根据模式初始化录制 */
  async start(): Promise<void> {
    await this.storageFs.ensureDir("recordings/.keep");

    /** 订阅 fMP4 segment 事件，写入环形缓冲和正在录像的 writer */
    this.unsubSegment = this.eventBus.on("fmp4:segment", ({ cameraId, moofData, mdatData }) => {
      this.writeSegment(cameraId, moofData, mdatData);
    });

    /** 订阅 fMP4 init 事件，更新环形缓冲的 init segment */
    this.unsubInit = this.eventBus.on("fmp4:init", ({ cameraId, segment }) => {
      const buf = this.ringBuffers.get(cameraId);
      if (buf) {
        buf.setInitSegment(segment);
      }
    });

    /** 订阅 detect:frame 事件填充 VLM 上下文帧缓冲 */
    this.unsubDetectFrame = this.eventBus.on("detect:frame", ({ cameraId, data, timestamp }) => {
      let buf = this.contextFrameBuffers.get(cameraId);
      if (!buf) {
        buf = [];
        this.contextFrameBuffers.set(cameraId, buf);
      }
      buf.push({ data, timestamp });
      /** 只保留最近 10 帧 */
      if (buf.length > 10) {
        buf.splice(0, buf.length - 10);
      }
    });

    const mode = this.runtimeConfig.get().recording.mode;
    this.startMode(mode);

    this.purgeTimer = setInterval(() => this.purgeOldRecordings(), 3600_000);
  }

  /** 根据模式启动对应的订阅 */
  private startMode(mode: string): void {
    if (mode === "continuous") {
      setTimeout(() => {
        for (const [cameraId] of this.cameraNames) {
          this.startContinuous(cameraId);
        }
      }, 3000);
    } else if (mode === "event") {
      this.startEventMode();
    } else {
      this.unsubMotion = this.eventBus.on("motion", ({ cameraId, timestamp }) => {
        const state = this.getOrCreateState(cameraId);
        if (!state.recording) {
          this.startRecording(cameraId, timestamp);
        } else {
          this.scheduleStop(cameraId);
        }
      });
    }
  }

  /** 停止所有录像 */
  stop(): void {
    if (this.unsubSegment) {
      this.unsubSegment();
      this.unsubSegment = null;
    }
    if (this.unsubInit) {
      this.unsubInit();
      this.unsubInit = null;
    }
    if (this.unsubDetectFrame) {
      this.unsubDetectFrame();
      this.unsubDetectFrame = null;
    }
    this.cleanupModeSubscriptions();
    if (this.purgeTimer) {
      clearInterval(this.purgeTimer);
      this.purgeTimer = null;
    }
    for (const [cameraId] of this.states) {
      this.forceStop(cameraId);
    }
  }

  /** 清理所有模式订阅 */
  private cleanupModeSubscriptions(): void {
    if (this.unsubMotion) {
      this.unsubMotion();
      this.unsubMotion = null;
    }
    for (const unsub of this.unsubEvents) {
      unsub();
    }
    this.unsubEvents = [];
  }

  /** 运行时切换录制模式 */
  reloadMode(): void {
    const mode = this.runtimeConfig.get().recording.mode;
    console.log(`[Recorder] 模式切换: ${mode}`);

    this.cleanupModeSubscriptions();
    for (const [cameraId] of this.states) {
      this.forceStop(cameraId);
    }

    if (mode === "event") {
      const config = this.runtimeConfig.get().recording;
      const maxBytes = config.bufferDurationMs * 256 * 1024;
      for (const [, buf] of this.ringBuffers) {
        buf.resize(maxBytes);
      }
    }

    this.startMode(mode);
  }

  /** event 模式：订阅触发事件 */
  private startEventMode(): void {
    const config = this.runtimeConfig.get().recording;
    const triggers = config.eventTriggers.length > 0 ? config.eventTriggers : DEFAULT_EVENT_TRIGGERS;

    if (triggers.includes("detect")) {
      const unsub = this.eventBus.on("detect", ({ cameraId, timestamp, detections }) => {
        if (detections && detections.length > 0) {
          this.onEventTrigger(cameraId, timestamp, "detect");
        }
      });
      this.unsubEvents.push(unsub);
    }

    if (triggers.includes("track:appeared")) {
      this.unsubEvents.push(this.eventBus.on("track:appeared", ({ cameraId, timestamp }) => {
        this.onEventTrigger(cameraId, timestamp, "track:appeared");
      }));
    }
    if (triggers.includes("track:enter-zone")) {
      this.unsubEvents.push(this.eventBus.on("track:enter-zone", ({ cameraId, timestamp }) => {
        this.onEventTrigger(cameraId, timestamp, "track:enter-zone");
      }));
    }
    if (triggers.includes("track:leave-zone")) {
      this.unsubEvents.push(this.eventBus.on("track:leave-zone", ({ cameraId, timestamp }) => {
        this.onEventTrigger(cameraId, timestamp, "track:leave-zone");
      }));
    }
    if (triggers.includes("track:loiter")) {
      this.unsubEvents.push(this.eventBus.on("track:loiter", ({ cameraId, timestamp }) => {
        this.onEventTrigger(cameraId, timestamp, "track:loiter");
      }));
    }
    if (triggers.includes("track:line-cross")) {
      this.unsubEvents.push(this.eventBus.on("track:line-cross", ({ cameraId, timestamp }) => {
        this.onEventTrigger(cameraId, timestamp, "track:line-cross");
      }));
    }

    if (triggers.includes("alert")) {
      this.unsubEvents.push(this.eventBus.on("alert", ({ cameraId, timestamp }) => {
        this.onEventTrigger(cameraId, timestamp, "alert");
      }));
    }
  }

  /** event 模式：事件触发录像 */
  private onEventTrigger(cameraId: string, timestamp: number, eventType: string): void {
    const state = this.getOrCreateState(cameraId);

    if (state.recording) {
      console.log(`[Recorder] ${cameraId} 事件 ${eventType} 延长录像`);
      this.scheduleEventStop(cameraId);
    } else {
      const config = this.runtimeConfig.get().recording;
      const preTime = timestamp - config.eventPreMs;
      const buf = this.ringBuffers.get(cameraId);
      if (!buf) return;

      const preBuffer = buf.snapshotFrom(preTime);
      if (!preBuffer || preBuffer.segments.length === 0) {
        console.log(`[Recorder] ${cameraId} 事件 ${eventType} 无预缓冲数据，跳过`);
        return;
      }

      const recordingStart = preBuffer.segments[0]!.timestamp;
      console.log(`[Recorder] ${cameraId} 事件 ${eventType} 触发录像, 预缓冲段: ${preBuffer.segments.length}`);
      this.startRecordingInternal(cameraId, recordingStart, preBuffer);
      this.scheduleEventStop(cameraId);
    }
  }

  /** event 模式：延迟停止录像 */
  private scheduleEventStop(cameraId: string): void {
    const state = this.states.get(cameraId);
    if (!state?.recording) return;

    if (state.stopTimer) {
      clearTimeout(state.stopTimer);
    }

    const postMs = this.runtimeConfig.get().recording.eventPostMs;
    state.stopTimer = setTimeout(() => {
      this.finishRecording(cameraId);
      state.stopTimer = null;
      console.log(`[Recorder] ${cameraId} 事件录像结束（事件后超时 ${postMs}ms）`);
    }, postMs);
  }

  /** 将 fMP4 segment 写入环形缓冲 + 正在录像的 writer */
  private writeSegment(cameraId: string, moofData: Buffer, mdatData: Buffer): void {
    const now = Date.now();

    /** 写入环形缓冲区 */
    const buf = this.ringBuffers.get(cameraId);
    if (buf) {
      buf.push(moofData, mdatData, now);
    }

    /** 如果正在录像，追加写入文件 */
    const state = this.states.get(cameraId);
    if (state?.recording && state.writer) {
      state.writer.appendSegment(moofData, mdatData).catch((err) => {
        console.error(`[Recorder] ${cameraId} 写入 segment 失败:`, err);
      });
      state.segmentCount++;
      state.lastSegmentTime = now;

      /** 通过 wall clock 估算录制时长 */
      state.recordedDurationMs = now - state.startTime;
    }
  }

  /** 录像列表缓存 */
  private listCache = new Map<string, { data: RecordingInfo[]; expiry: number }>();
  private static readonly LIST_CACHE_TTL = 30_000;

  /** 清除录像列表缓存 */
  invalidateListCache(): void {
    this.listCache.clear();
  }

  /** 列出录像文件 — 从 SQLite 索引查询 */
  listRecordings(cameraId?: string, since?: number, until?: number): RecordingInfo[] {
    const cacheKey = `${cameraId ?? ""}:${since ?? 0}:${until ?? 0}`;
    const cached = this.listCache.get(cacheKey);
    if (cached && Date.now() < cached.expiry) return cached.data;

    const entries = this.storageFs.fileIndex.listFiles({
      category: "recordings",
      cameraId: cameraId ?? undefined,
      since: since ?? undefined,
      until: until ?? undefined,
    });

    const results: RecordingInfo[] = entries.map(e => {
      const file = e.relativePath.includes("/") ? e.relativePath.split("/").pop()! : e.relativePath;
      const camId = e.cameraId ?? (e.relativePath.includes("/") ? e.relativePath.split("/")[0]! : "");
      const parsed = this.parseFilename(file);
      let endTime = parsed.endTime;
      if (!endTime) {
        if (e.extra) {
          try {
            const ex = JSON.parse(e.extra) as { durationMs?: number };
            if (ex.durationMs) endTime = parsed.startTime + ex.durationMs;
          } catch { /* */ }
        }
        if (!endTime) endTime = e.mtimeMs;
      }
      return {
        filename: `${camId}/${file}`,
        cameraId: camId,
        startTime: parsed.startTime,
        endTime,
        size: e.size,
      };
    });

    const filtered = results.filter(r => {
      if (since && r.endTime < since) return false;
      if (until && r.startTime > until) return false;
      return true;
    });

    const sorted = filtered.sort((a, b) => b.startTime - a.startTime);

    this.listCache.set(cacheKey, { data: sorted, expiry: Date.now() + MotionRecorder.LIST_CACHE_TTL });
    return sorted;
  }

  /** 获取录像文件路径 */
  getRecordingPath(relativePath: string): string {
    return join(this.storagePath, relativePath);
  }

  /** 获取所有摄像头的当前录像状态 */
  getRecordingStates(): Array<{ cameraId: string; recording: boolean; startTime: number }> {
    const result: Array<{ cameraId: string; recording: boolean; startTime: number }> = [];
    for (const [cameraId, state] of this.states) {
      result.push({ cameraId, recording: state.recording, startTime: state.startTime });
    }
    return result;
  }

  /** 持续录制：启动一段录制，到时后自动开始下一段 */
  private startContinuous(cameraId: string): void {
    const state = this.getOrCreateState(cameraId);
    if (state.recording) return;

    const segmentSec = this.runtimeConfig.get().recording.segmentDuration;
    const now = Date.now();

    const buf = this.ringBuffers.get(cameraId);
    if (!buf || !buf.initSegment) {
      console.warn(`[Recorder] ${cameraId} 无 fMP4 缓冲数据，延迟 3 秒重试持续录制`);
      setTimeout(() => this.startContinuous(cameraId), 3000);
      return;
    }

    /** 持续录制从当前缓冲的最早帧开始 */
    const allData = buf.snapshotFrom(0);
    this.startRecordingInternal(cameraId, now, allData);

    state.continuousTimer = setTimeout(() => {
      this.finishRecording(cameraId);
      this.startContinuous(cameraId);
    }, segmentSec * 1000);
  }

  /** 开始录像（motion 触发模式） */
  private startRecording(cameraId: string, timestamp: number): void {
    const buf = this.ringBuffers.get(cameraId);
    if (!buf) return;

    const preBuffer = buf.drain();
    if (!preBuffer || preBuffer.segments.length === 0) {
      console.log(`[Recorder] ${cameraId} 无预缓冲数据，跳过录像`);
      return;
    }

    const recordingStart = preBuffer.segments[0]!.timestamp;
    this.startRecordingInternal(cameraId, recordingStart, preBuffer);
  }

  /**
   * 启动录像：从 fMP4 预缓冲数据创建文件写入器
   */
  private async startRecordingInternal(
    cameraId: string,
    timestamp: number,
    preBuffer: { initSegment: { data: Buffer; codec: string }; segments: Array<{ moofData: Buffer; mdatData: Buffer; timestamp: number; byteSize: number }> } | null,
  ): Promise<void> {
    const state = this.getOrCreateState(cameraId);

    /** 防御性清理：如果旧 writer 还在运行，先关闭 */
    if (state.writer) {
      state.writer.forceClose();
      state.writer = null;
    }

    if (state.stopTimer) {
      clearTimeout(state.stopTimer);
      state.stopTimer = null;
    }

    const d = new Date(timestamp);
    const pad = (n: number) => String(n).padStart(2, "0");
    const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const timeStr = `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
    const filename = `${dateStr}_${timeStr}.mp4`;

    await this.storageFs.ensureDir(`recordings/${cameraId}/${filename}`);
    const outputPath = join(this.storagePath, cameraId, filename);

    const wm = this.runtimeConfig.get().recording.watermark;

    if (wm.enabled) {
      const filter = Fmp4Writer.buildWatermarkFilter(
        this.cameraNames.get(cameraId),
        wm,
      );
      const encoderArgs = this.getEncoderArgs();
      state.writer = await Fmp4Writer.createTranscode(outputPath, this.ffmpegPath, filter, encoderArgs);
    } else {
      state.writer = await Fmp4Writer.createDirect(outputPath);
    }

    console.log(`[Recorder] ${cameraId} 开始录像 (fMP4): ${filename}${wm.enabled ? " (带水印)" : ""}`);

    /** 写入 init segment */
    if (preBuffer?.initSegment) {
      await state.writer.writeInit(preBuffer.initSegment as { type: "init"; codec: string; audioCodec: string; data: Buffer });
    }

    /** 写入预缓冲的 media segments */
    if (preBuffer?.segments && preBuffer.segments.length > 0) {
      for (const seg of preBuffer.segments) {
        await state.writer.appendSegment(seg.moofData, seg.mdatData);
      }
      console.log(`[Recorder] ${cameraId} 写入预缓冲段: ${preBuffer.segments.length}`);
    }

    state.recording = true;
    state.startTime = timestamp;
    state.filename = filename;
    state.segmentCount = preBuffer?.segments?.length ?? 0;
    state.recordedDurationMs = 0;
    state.lastSegmentTime = Date.now();
  }

  /** 结束录像：关闭 writer，注册文件索引 */
  private async finishRecording(cameraId: string): Promise<void> {
    const state = this.states.get(cameraId);
    if (!state?.recording || !state.writer) return;

    const filename = state.filename;
    const startTime = state.startTime;

    state.recording = false;
    const writer = state.writer;
    state.writer = null;

    await writer.close();

    console.log(`[Recorder] ${cameraId} 录像结束: ${filename}, ${state.segmentCount} segments`);

    /** 异步注册文件索引 */
    this.handleRecordingExit(cameraId, filename, startTime).catch(err => {
      console.error(`[Recorder] ${cameraId} 注册录像索引失败:`, err);
    });
  }

  /** 录像完成后注册索引或清理无效文件 */
  private async handleRecordingExit(cameraId: string, filename: string, startTime: number): Promise<void> {
    const relativePath = `${cameraId}/${filename}`;
    const fileInfo = await this.storageFs.stat(`recordings/${relativePath}`);
    const state = this.states.get(cameraId);

    if (!fileInfo || fileInfo.size < 1024) {
      if (fileInfo) {
        await this.storageFs.deleteFile(`recordings/${relativePath}`, { category: "recordings" });
      }
      console.warn(`[Recorder] ${cameraId} 清理无效录像: ${filename} (${fileInfo?.size ?? 0} bytes)`);
      this.listCache.clear();
    } else {
      this.storageFs.fileIndex.registerFile({
        category: "recordings",
        relativePath,
        cameraId,
        size: fileInfo.size,
        mtimeMs: fileInfo.mtimeMs,
        createdAt: startTime,
        extra: state?.recordedDurationMs ? JSON.stringify({ durationMs: state.recordedDurationMs }) : undefined,
      });
      this.listCache.clear();
    }

    /** 连续录制模式下，检查是否需要重启 */
    if (state?.continuousTimer) {
      /** continuous 模式的定时器仍在，无需额外处理 */
    }
  }

  /** 延迟停止录像（motion 模式） */
  private scheduleStop(cameraId: string): void {
    const state = this.states.get(cameraId);
    if (!state?.recording) return;

    if (state.stopTimer) {
      clearTimeout(state.stopTimer);
    }

    const postDuration = this.runtimeConfig.get().recording.postMotionDuration;
    state.stopTimer = setTimeout(() => {
      this.finishRecording(cameraId);
      state.stopTimer = null;
      console.log(`[Recorder] ${cameraId} 停止录像（无运动超时）`);
    }, postDuration);
  }

  /** 立即强制停止录像 */
  private forceStop(cameraId: string): void {
    const state = this.states.get(cameraId);
    if (!state) return;
    if (state.stopTimer) {
      clearTimeout(state.stopTimer);
      state.stopTimer = null;
    }
    if (state.continuousTimer) {
      clearTimeout(state.continuousTimer);
      state.continuousTimer = null;
    }
    if (state.writer) {
      state.writer.forceClose();
      state.writer = null;
    }
    state.recording = false;
  }

  /**
   * 从上下文帧缓冲中按时间间隔取帧
   * 用于 VLM 多帧检测
   */
  getContextFrames(cameraId: string, now: number, intervalMs: number, maxFrames: number = 3): Array<{ data: Buffer; timestamp: number }> {
    const buf = this.contextFrameBuffers.get(cameraId);
    if (!buf || buf.length === 0 || intervalMs <= 0) return [];

    const result: Array<{ data: Buffer; timestamp: number }> = [];
    for (let i = 1; i <= maxFrames; i++) {
      const targetTime = now - intervalMs * i;
      let best = -1;
      let bestDist = Infinity;
      for (let j = 0; j < buf.length; j++) {
        const dist = Math.abs(buf[j]!.timestamp - targetTime);
        if (dist < bestDist) { bestDist = dist; best = j; }
      }
      if (best >= 0 && bestDist < intervalMs * 0.5) {
        result.unshift(buf[best]!);
      }
    }
    return result;
  }

  /** 根据配置返回 ffmpeg 编码器参数（仅水印转码模式使用） */
  private getEncoderArgs(): string[] {
    const encoder = this.runtimeConfig.get().recording.encoder;
    switch (encoder) {
      case "h264_v4l2m2m":
        return ["-c:v", "h264_v4l2m2m", "-pix_fmt", "yuv420p"];
      case "h264_vaapi":
        return [
          "-vaapi_device", "/dev/dri/renderD128",
          "-c:v", "h264_vaapi",
          "-vf", "format=nv12,hwupload",
          "-qp", "23",
        ];
      case "h264_nvenc":
        return ["-c:v", "h264_nvenc", "-preset", "p1", "-tune", "ll", "-cq", "23"];
      case "libx264":
        return ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-pix_fmt", "yuv420p"];
      default:
        return ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-pix_fmt", "yuv420p"];
    }
  }

  /** 删除所有录像文件 */
  async purgeAll(): Promise<number> {
    const count = await this.storageFs.deleteAllFiles("recordings");
    this.listCache.clear();
    return count;
  }

  /** 清理过期录像 */
  async purgeOldRecordings(overrideRetentionDays?: number): Promise<void> {
    const retentionDays = overrideRetentionDays ?? this.runtimeConfig.get().recording.retentionDays;
    const cutoff = Date.now() - retentionDays * 86400_000;

    const deleted = await this.storageFs.deleteExpiredFiles("recordings", cutoff);
    if (deleted > 0) {
      console.log(`[Recorder] 清理过期录像: ${deleted} 个文件`);
    }

    /** 清理幽灵索引 */
    const allEntries = this.storageFs.fileIndex.listFiles({ category: "recordings" });
    const stalePaths: string[] = [];
    for (const r of allEntries) {
      const fullPath = join(this.storagePath, r.relativePath);
      try {
        await stat(fullPath);
      } catch {
        stalePaths.push(r.relativePath);
      }
    }
    for (const p of stalePaths) {
      this.storageFs.fileIndex.removeFile("recordings", p);
    }
    if (stalePaths.length > 0) {
      console.log(`[Recorder] 清理 ${stalePaths.length} 条幽灵索引`);
    }

    this.listCache.clear();
  }

  /** 解析录像文件名获取时间信息 */
  private parseFilename(filename: string): { startTime: number; endTime: number | null } {
    const match = filename.match(/^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})/);
    if (!match) return { startTime: 0, endTime: null };

    const dateStr = `${match[1]}T${match[2]}:${match[3]}:${match[4]}`;
    return {
      startTime: new Date(dateStr).getTime(),
      endTime: null,
    };
  }

  /** 获取或创建摄像头录像状态 */
  private getOrCreateState(cameraId: string): RecordingState {
    const existing = this.states.get(cameraId);
    if (existing) return existing;

    const state: RecordingState = {
      recording: false,
      startTime: 0,
      stopTimer: null,
      continuousTimer: null,
      writer: null,
      filename: "",
      segmentCount: 0,
      recordedDurationMs: 0,
      lastSegmentTime: 0,
    };
    this.states.set(cameraId, state);
    return state;
  }
}
