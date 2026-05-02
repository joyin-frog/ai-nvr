import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { type EventBus } from "@/event-bus";
import { type RuntimeConfig } from "@/runtime-config";
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

/**
 * O(1) 环形帧缓冲区
 * 保存最近 N 帧 JPEG 数据，push/drain 均为 O(1)
 */
class FrameRingBuffer {
  private buf: Array<{ data: Buffer; timestamp: number } | undefined>;
  private head = 0;
  private tail = 0;
  private count = 0;
  private capacity: number;

  constructor(maxSize: number = 30) {
    this.capacity = maxSize;
    this.buf = new Array(maxSize);
  }

  /** O(1) 追加一帧 */
  push(data: Buffer, timestamp: number): void {
    this.buf[this.tail] = { data, timestamp };
    this.tail = (this.tail + 1) % this.capacity;
    if (this.count < this.capacity) {
      this.count++;
    } else {
      /** 满了，head 跟进（覆盖最旧帧） */
      this.head = (this.head + 1) % this.capacity;
    }
  }

  /** O(n) 取出所有缓冲帧（清空缓冲区），n = count */
  drain(): Array<{ data: Buffer; timestamp: number }> {
    if (this.count === 0) return [];
    const result: Array<{ data: Buffer; timestamp: number }> = [];
    for (let i = 0; i < this.count; i++) {
      const idx = (this.head + i) % this.capacity;
      const frame = this.buf[idx]!;
      result.push(frame);
      this.buf[idx] = undefined;
    }
    this.head = 0;
    this.tail = 0;
    this.count = 0;
    return result;
  }

  /** O(n) 返回指定时间戳之后的所有帧（拷贝，不清空） */
  snapshotFrom(afterTimestamp: number): Array<{ data: Buffer; timestamp: number }> {
    if (this.count === 0) return [];
    const result: Array<{ data: Buffer; timestamp: number }> = [];
    for (let i = 0; i < this.count; i++) {
      const frame = this.buf[(this.head + i) % this.capacity]!;
      if (frame.timestamp > afterTimestamp) {
        for (let j = i; j < this.count; j++) {
          result.push(this.buf[(this.head + j) % this.capacity]!);
        }
        return result;
      }
    }
    return result;
  }

  /** 调整缓冲区大小 */
  resize(newMaxSize: number): void {
    if (newMaxSize === this.capacity) return;
    const old = this.drain();
    this.capacity = newMaxSize;
    this.buf = new Array(newMaxSize);
    this.head = 0;
    this.tail = 0;
    this.count = 0;
    /** 只保留最新的 newMaxSize 帧 */
    const start = Math.max(0, old.length - newMaxSize);
    for (let i = start; i < old.length; i++) {
      const f = old[i];
      if (f) this.push(f.data, f.timestamp);
    }
  }

  /** 清空缓冲区 */
  clear(): void {
    for (let i = 0; i < this.count; i++) {
      this.buf[(this.head + i) % this.capacity] = undefined;
    }
    this.head = 0;
    this.tail = 0;
    this.count = 0;
  }

  /** 当前帧数 */
  get length(): number {
    return this.count;
  }
}

/** 每个摄像头的录像状态 */
interface RecordingState {
  /** 当前正在运行的 ffmpeg 录像进程 */
  proc: ReturnType<typeof spawn> | null;
  /** 是否正在录像 */
  recording: boolean;
  /** 最后一次 motion 时间 */
  lastMotionTime: number;
  /** 当前录像开始时间 */
  startTime: number;
  /** 停止定时器 */
  stopTimer: ReturnType<typeof setTimeout> | null;
  /** 持续录制定时器（用于自动分段） */
  continuousTimer: ReturnType<typeof setTimeout> | null;
  /** ffmpeg stdin 写锁（避免并发 write） */
  writing: boolean;
  /** 上次写入帧的时间戳（用于帧率节流） */
  lastWriteTime: number;
  /** 高帧率模式截止时间（motion 触发后 2 秒内 ~30fps，之后恢复 15fps） */
  boostUntil: number;
}

/** drawtext 水印默认字体路径 */
const DEFAULT_FONT = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc";

/** event 模式下触发录像的事件类型列表 */
const DEFAULT_EVENT_TRIGGERS = [
  "detect",
  "track:appeared",
  "track:enter-zone",
  "track:loiter",
  "track:line-cross",
  "alert",
];

/**
 * 录像器
 * 支持三种模式：motion（变动触发）/ continuous（持续录制）/ event（事件驱动）
 * 通过 EventBus 接收帧数据，用 ffmpeg pipe 输入编码为 MP4
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
  /** 帧事件取消订阅函数 */
  private unsubFrame: (() => void) | null = null;
  /** motion 事件取消订阅 */
  private unsubMotion: (() => void) | null = null;
  /** event 模式事件取消订阅列表 */
  private unsubEvents: (() => void)[] = [];
  /** 过期录像清理定时器 */
  private purgeTimer: ReturnType<typeof setInterval> | null = null;
  /** 存储文件系统 */
  private storageFs: StorageFs;
  /** 每路摄像头的帧缓冲区（motion 模式 = 预缓冲 ~2 秒，event 模式 = 环形缓冲 ~30 秒） */
  private ringBuffers = new Map<string, FrameRingBuffer>();
  /** event 模式下每路摄像头缓冲区的上次写入时间（独立于 ffmpeg 写入时间） */
  private bufferLastWrite = new Map<string, number>();

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
    this.bufferLastWrite.delete(cameraId);
    this.states.delete(cameraId);
  }

  /** 获取或创建指定摄像头的环形缓冲区 */
  private getOrCreateBuffer(cameraId: string): FrameRingBuffer {
    let buf = this.ringBuffers.get(cameraId);
    if (!buf) {
      const config = this.runtimeConfig.get().recording;
      const size = config.mode === "event"
        ? Math.ceil(config.bufferDurationMs / MotionRecorder.WRITE_THROTTLE_MS)
        : 30;
      buf = new FrameRingBuffer(size);
      this.ringBuffers.set(cameraId, buf);
    }
    return buf;
  }

  /**
   * 从帧缓冲区中按时间间隔取上下文帧
   * 用于 VLM 多帧检测：取当前帧之前、按 intervalMs 间隔均匀分布的历史帧
   */
  getContextFrames(cameraId: string, now: number, intervalMs: number, maxFrames: number = 3): Array<{ data: Buffer; timestamp: number }> {
    const buf = this.ringBuffers.get(cameraId);
    if (!buf || intervalMs <= 0) return [];
    const all = buf.snapshotFrom(0);
    if (all.length === 0) return [];
    const result: Array<{ data: Buffer; timestamp: number }> = [];
    for (let i = 1; i <= maxFrames; i++) {
      const targetTime = now - intervalMs * i;
      /** 找最接近 targetTime 的帧 */
      let best = -1;
      let bestDist = Infinity;
      for (let j = 0; j < all.length; j++) {
        const dist = Math.abs(all[j]!.timestamp - targetTime);
        if (dist < bestDist) { bestDist = dist; best = j; }
      }
      if (best >= 0 && bestDist < intervalMs * 0.5) {
        result.unshift(all[best]!);
      }
    }
    return result;
  }

  /** 启动：订阅帧事件 + 根据模式初始化录制 */
  async start(): Promise<void> {
    /** 确保录像根目录存在 */
    await this.storageFs.ensureDir("recordings/.keep");

    /** 订阅帧事件，写入缓冲区和正在录像的 ffmpeg 进程 */
    this.unsubFrame = this.eventBus.on("frame", ({ cameraId, data }) => {
      this.writeFrame(cameraId, data);
    });

    const mode = this.runtimeConfig.get().recording.mode;
    this.startMode(mode);

    /** 定期清理过期录像 */
    this.purgeTimer = setInterval(() => this.purgeOldRecordings(), 3600_000);
  }

  /** 根据模式启动对应的订阅 */
  private startMode(mode: string): void {
    if (mode === "continuous") {
      /** 持续录制模式延迟启动（等帧提取器连接成功后再开始） */
      setTimeout(() => {
        for (const [cameraId] of this.cameraNames) {
          this.startContinuous(cameraId);
        }
      }, 3000);
    } else if (mode === "event") {
      this.startEventMode();
    } else {
      /** motion 触发模式 */
      this.unsubMotion = this.eventBus.on("motion", ({ cameraId, timestamp }) => {
        const state = this.getOrCreateState(cameraId);
        state.lastMotionTime = timestamp;
        state.boostUntil = timestamp + MotionRecorder.WRITE_BOOST_DURATION_MS;

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
    if (this.unsubFrame) {
      this.unsubFrame();
      this.unsubFrame = null;
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

    /** 先停止所有当前模式 */
    this.cleanupModeSubscriptions();
    for (const [cameraId] of this.states) {
      this.forceStop(cameraId);
    }

    /** event 模式下调整缓冲区大小 */
    if (mode === "event") {
      const config = this.runtimeConfig.get().recording;
      const size = Math.ceil(config.bufferDurationMs / MotionRecorder.WRITE_THROTTLE_MS);
      for (const [, buf] of this.ringBuffers) {
        buf.resize(size);
      }
    }

    this.startMode(mode);
  }

  /** event 模式：订阅触发事件 */
  private startEventMode(): void {
    const config = this.runtimeConfig.get().recording;
    const triggers = config.eventTriggers.length > 0 ? config.eventTriggers : DEFAULT_EVENT_TRIGGERS;

    /** detect 事件 — 仅当检测到目标时触发 */
    if (triggers.includes("detect")) {
      const unsub = this.eventBus.on("detect", ({ cameraId, timestamp, detections }) => {
        if (detections && detections.length > 0) {
          this.onEventTrigger(cameraId, timestamp, "detect");
        }
      });
      this.unsubEvents.push(unsub);
    }

    /** track 类事件 */
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

    /** alert 事件 */
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
      /** 已在录像 → 重置 postEventMs 定时器（延长录像） */
      console.log(`[Recorder] ${cameraId} 事件 ${eventType} 延长录像`);
      state.boostUntil = timestamp + MotionRecorder.WRITE_BOOST_DURATION_MS;
      this.scheduleEventStop(cameraId);
    } else {
      /** 不在录像 → 从环形缓冲区取事件前帧 + 启动 ffmpeg */
      const config = this.runtimeConfig.get().recording;
      const preTime = timestamp - config.eventPreMs;
      const buf = this.getOrCreateBuffer(cameraId);
      const preFrames = buf.snapshotFrom(preTime);

      const recordingStart = preFrames.length > 0 ? preFrames[0]!.timestamp : timestamp;
      console.log(`[Recorder] ${cameraId} 事件 ${eventType} 触发录像, 预缓冲帧: ${preFrames.length}`);
      this.startRecordingInternal(cameraId, recordingStart, preFrames);
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
      if (state.proc) {
        state.proc.stdin?.end();
      }
      state.stopTimer = null;
      console.log(`[Recorder] ${cameraId} 事件录像结束（事件后超时 ${postMs}ms）`);
    }, postMs);
  }

  /** 根据配置返回 ffmpeg 编码器参数 */
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

  /** 录像帧写入节流间隔（~15fps） */
  private static readonly WRITE_THROTTLE_MS = 67;
  /** motion 触发后 boost 期间的节流间隔（~30fps） */
  private static readonly WRITE_BOOST_THROTTLE_MS = 33;
  /** motion 触发后 boost 持续时间 */
  private static readonly WRITE_BOOST_DURATION_MS = 2000;

  /** 将帧数据写入录像进程或缓冲区 */
  private writeFrame(cameraId: string, jpegData: Buffer): void {
    const now = Date.now();
    const mode = this.runtimeConfig.get().recording.mode;

    /** event 模式下始终写入环形缓冲区（独立于 ffmpeg 写入时间，确保录像结束后缓冲区有最新帧） */
    if (mode === "event") {
      const buf = this.getOrCreateBuffer(cameraId);
      if (now - (this.bufferLastWrite.get(cameraId) ?? 0) >= MotionRecorder.WRITE_THROTTLE_MS) {
        buf.push(jpegData, now);
        this.bufferLastWrite.set(cameraId, now);
      }
    }

    const state = this.states.get(cameraId);

    if (!state?.recording || !state.proc?.stdin?.writable || state.writing) {
      /** 不在录像状态 → 缓存到缓冲区（motion 触发模式） */
      if (mode === "motion") {
        const buf = this.getOrCreateBuffer(cameraId);
        if (now - (state?.lastWriteTime ?? 0) >= MotionRecorder.WRITE_THROTTLE_MS) {
          buf.push(jpegData, now);
        }
      }
      return;
    }

    /** 帧率节流：boost 期间 ~30fps，正常 ~15fps */
    const throttle = now < state.boostUntil
      ? MotionRecorder.WRITE_BOOST_THROTTLE_MS
      : MotionRecorder.WRITE_THROTTLE_MS;
    if (now - state.lastWriteTime < throttle) return;
    state.lastWriteTime = now;

    state.writing = true;
    state.proc.stdin.write(jpegData, () => {
      state.writing = false;
    });
  }

  /** 录像列表缓存 */
  private listCache = new Map<string, { data: RecordingInfo[]; expiry: number }>();
  private static readonly LIST_CACHE_TTL = 30_000;

  /** 清除录像列表缓存 */
  invalidateListCache(): void {
    this.listCache.clear();
  }

  /** 列出录像文件 — 从 SQLite 索引查询，不扫描文件系统 */
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

    this.startRecordingInternal(cameraId, now);

    /** 设置分段定时器，到达分段时长后重启下一段 */
    state.continuousTimer = setTimeout(() => {
      this.forceStop(cameraId);
      /** 立即开始下一段 */
      this.startContinuous(cameraId);
    }, segmentSec * 1000);
  }

  /** 开始录像（motion 触发模式） */
  private startRecording(cameraId: string, timestamp: number): void {
    /** motion 模式使用 drain 清空预缓冲 */
    const buf = this.getOrCreateBuffer(cameraId);
    const preFrames = buf.drain();
    this.startRecordingInternal(cameraId, timestamp, preFrames);
  }

  /** 启动录像：通过 ffmpeg pipe 接收 JPEG 帧并编码为 MP4 */
  private async startRecordingInternal(
    cameraId: string,
    timestamp: number,
    preFrames?: Array<{ data: Buffer; timestamp: number }>,
  ): Promise<void> {
    const state = this.getOrCreateState(cameraId);

    /** 防御性清理：如果旧 ffmpeg 进程还在运行，先 kill */
    if (state.proc) {
      state.proc.kill("SIGKILL");
      state.proc.unref();
      state.proc = null;
    }

    /** 取消待执行的停止定时器 */
    if (state.stopTimer) {
      clearTimeout(state.stopTimer);
      state.stopTimer = null;
    }

    const date = new Date(timestamp);
    const dateStr = date.toISOString().slice(0, 10);
    const timeStr = date.toISOString().slice(11, 19).replace(/:/g, "-");
    const filename = `${dateStr}_${timeStr}.mp4`;

    /** 确保录像目录存在 */
    await this.storageFs.ensureDir(`recordings/${cameraId}/${filename}`);
    const outputPath = join(this.storagePath, cameraId, filename);

    /** 构建 drawtext 水印滤镜 */
    const wm = this.runtimeConfig.get().recording.watermark;
    const filterParts: string[] = [];
    if (wm.enabled) {
      const camName = this.cameraNames.get(cameraId);
      const posCoords = (pos: string) => {
        switch (pos) {
          case "top-right": return { x: "w-tw-10", y: "10" };
          case "bottom-left": return { x: "10", y: "h-th-10" };
          case "bottom-right": return { x: "w-tw-10", y: "h-th-10" };
          default: return { x: "10", y: "10" };
        }
      };
      if (camName) {
        const safeName = camName.replace(/'/g, "'\\''");
        const { x, y } = posCoords(wm.namePosition);
        filterParts.push(
          `drawtext=fontfile='${DEFAULT_FONT}':text='${safeName}':x=${x}:y=${y}:fontsize=${wm.fontSize + 4}:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=4`,
        );
      }
      const { x, y } = posCoords(wm.timePosition);
      const timeText = "%{localtime\\:%Y-%m-%d %H\\:%M\\:%S}";
      filterParts.push(
        `drawtext=fontfile='${DEFAULT_FONT}':text='${timeText}':x=${x}:y=${y}:fontsize=${wm.fontSize}:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=4`,
      );
    }

    /** ffmpeg 从 stdin 读取 JPEG 帧，编码为 MP4 */
    const encoderConfig = this.getEncoderArgs();
    const args = [
      "-f", "image2pipe",
      "-vcodec", "mjpeg",
      "-i", "pipe:0",
      ...(filterParts.length > 0 ? ["-vf", filterParts.join(",")] : []),
      ...encoderConfig,
      "-r", "15",
      "-movflags", "+faststart",
      "-an",
      "-y",
      outputPath,
    ];

    console.log(`[Recorder] ${cameraId} 开始录像 (帧输入): ${filename}`);
    const proc = spawn(this.ffmpegPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg.includes("error") || msg.includes("Error")) {
        console.error(`[Recorder] ${cameraId} ffmpeg error:`, msg);
      }
    });

    proc.stdin?.on("error", () => {
      /** stdin 写入失败（进程已退出等），忽略 */
    });

    proc.on("exit", (code) => {
      console.log(`[Recorder] ${cameraId} 录像结束, code=${code}`);
      /** 只有当前进程仍是这个 proc 时才清理状态（防止 forceStop + 新录像的竞态） */
      if (state.proc === proc) {
        proc.unref();
        state.proc = null;
        state.recording = false;
      }

      /** 异步处理录像完成后的注册/清理 */
      this.handleRecordingExit(cameraId, filename, code, state);
    });

    state.recording = true;
    state.proc = proc;
    state.startTime = timestamp;
    state.boostUntil = timestamp + MotionRecorder.WRITE_BOOST_DURATION_MS;

    /** 写入预缓冲帧（事件前/motion 前的帧） */
    if (preFrames && preFrames.length > 0) {
      console.log(`[Recorder] ${cameraId} 写入预缓冲帧: ${preFrames.length} 帧`);
      for (const frame of preFrames) {
        proc.stdin?.write(frame.data);
      }
    }
  }

  /** ffmpeg 退出后异步处理：注册索引或清理无效文件 */
  private async handleRecordingExit(cameraId: string, filename: string, code: number | null, state: RecordingState): Promise<void> {
    const relativePath = `${cameraId}/${filename}`;
    const fileInfo = await this.storageFs.stat(`recordings/${relativePath}`);

    if (!fileInfo || fileInfo.size < 1024) {
      /** 清理无效录像（< 1KB） */
      if (fileInfo) {
        await this.storageFs.deleteFile(`recordings/${relativePath}`, { category: "recordings" });
      }
      console.warn(`[Recorder] ${cameraId} 清理无效录像: ${filename} (${fileInfo?.size ?? 0} bytes)`);
      this.listCache.clear();
    } else if (code === 0) {
      /** 有效录像 → 注册到文件索引 */
      this.storageFs.fileIndex.registerFile({
        category: "recordings",
        relativePath,
        cameraId,
        size: fileInfo.size,
        mtimeMs: fileInfo.mtimeMs,
        createdAt: state.startTime,
      });
      this.listCache.clear();
    }

    /** 连续录制模式下非正常退出：3 秒后自动重启 */
    if (code !== 0 && state.continuousTimer) {
      clearTimeout(state.continuousTimer);
      state.continuousTimer = null;
      console.warn(`[Recorder] ${cameraId} ffmpeg 异常退出 (code=${code})，3 秒后重启连续录制`);
      setTimeout(() => {
        if (!state.continuousTimer && !state.recording) {
          this.startContinuous(cameraId);
        }
      }, 3000);
    }
  }

  /** 延迟停止录像（motion 模式：最后一次 motion 后等待一段时间） */
  private scheduleStop(cameraId: string): void {
    const state = this.states.get(cameraId);
    if (!state?.recording) return;

    if (state.stopTimer) {
      clearTimeout(state.stopTimer);
    }

    const postDuration = this.runtimeConfig.get().recording.postMotionDuration;
    state.stopTimer = setTimeout(() => {
      if (state.proc) {
        /** 关闭 stdin 让 ffmpeg 自然结束（写入 MP4 文件尾） */
        state.proc.stdin?.end();
      }
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
    if (state.proc) {
      const oldProc = state.proc;
      state.proc = null;
      /** 关闭 stdin 让 ffmpeg 优雅退出 */
      oldProc.stdin?.end();
      oldProc.unref();
    }
    state.recording = false;
  }

  /** 删除所有录像文件，返回删除的文件数量 */
  async purgeAll(): Promise<number> {
    const count = await this.storageFs.deleteAllFiles("recordings");
    this.listCache.clear();
    return count;
  }

  /** 清理过期录像（通过索引查询，异步删除） */
  async purgeOldRecordings(overrideRetentionDays?: number): Promise<void> {
    const retentionDays = overrideRetentionDays ?? this.runtimeConfig.get().recording.retentionDays;
    const cutoff = Date.now() - retentionDays * 86400_000;

    const deleted = await this.storageFs.deleteExpiredFiles("recordings", cutoff);
    if (deleted > 0) {
      console.log(`[Recorder] 清理过期录像: ${deleted} 个文件`);
    }

    /** 异步清理幽灵索引：索引中有记录但文件已不存在 */
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

    const state: RecordingState = { proc: null, recording: false, lastMotionTime: 0, startTime: 0, stopTimer: null, continuousTimer: null, writing: false, lastWriteTime: 0, boostUntil: 0 };
    this.states.set(cameraId, state);
    return state;
  }
}
