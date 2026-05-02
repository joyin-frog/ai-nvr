import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readSync, readdirSync, statSync, unlinkSync } from "node:fs";
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
 * 环形帧缓冲区
 * 保存最近 N 帧 JPEG 数据，用于 motion 触发前的预缓冲录像
 */
class FrameRingBuffer {
  /** 缓冲帧数组 */
  private frames: Array<{ data: Buffer; timestamp: number }> = [];
  /** 最大帧数（约 2 秒 @15fps） */
  private maxSize: number;

  constructor(maxSize: number = 30) {
    this.maxSize = maxSize;
  }

  /** 追加一帧 */
  push(data: Buffer, timestamp: number): void {
    this.frames.push({ data, timestamp });
    if (this.frames.length > this.maxSize) {
      this.frames.shift();
    }
  }

  /** 取出所有缓冲帧（清空缓冲区） */
  drain(): Array<{ data: Buffer; timestamp: number }> {
    const result = this.frames;
    this.frames = [];
    return result;
  }

  /** 清空缓冲区 */
  clear(): void {
    this.frames = [];
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
}

/**
 * 从 MP4 文件的 moov.mvhd atom 中解析视频时长（毫秒）
 * faststart 文件 moov 在文件头部，只需读前 64KB
 * 解析失败返回 null（调用方回退到 mtime）
 */
function parseMp4DurationMs(filePath: string): number | null {
  try {
    const stat = statSync(filePath);
    /** 只读前 64KB，faststart 文件的 moov 在这个范围内 */
    const readLen = Math.min(65536, stat.size);
    const buf = Buffer.alloc(readLen);
    const fd = openSync(filePath, "r");
    readSync(fd, buf, 0, readLen, 0);
    closeSync(fd);

    /** 遍历顶层 atom 查找 moov */
    let offset = 0;
    while (offset + 8 <= buf.length) {
      const atomSize = buf.readUInt32BE(offset);
      const atomType = buf.toString("ascii", offset + 4, offset + 8);

      if (atomType === "moov") {
        /** 在 moov 内搜索 mvhd */
        const moovEnd = Math.min(offset + atomSize, buf.length);
        let inner = offset + 8;
        while (inner + 8 <= moovEnd) {
          const innerSize = buf.readUInt32BE(inner);
          const innerType = buf.toString("ascii", inner + 4, inner + 8);

          if (innerType === "mvhd" && inner + innerSize <= buf.length) {
            const version = buf[inner + 8]!;
            if (version === 0) {
              /** version 0: timescale(u32) + duration(u32) */
              const timescale = buf.readUInt32BE(inner + 20);
              const duration = buf.readUInt32BE(inner + 24);
              if (timescale > 0) return Math.round((duration / timescale) * 1000);
            } else if (version === 1) {
              /** version 1: timescale(u32) + duration(u64) */
              const timescale = buf.readUInt32BE(inner + 28);
              const duration = Number(buf.readBigUInt64BE(inner + 32));
              if (timescale > 0) return Math.round((duration / timescale) * 1000);
            }
            return null;
          }
          if (innerSize < 8) break;
          inner += innerSize;
        }
        return null;
      }

      if (atomSize < 8) break;
      offset += atomSize;
    }
  } catch {
    // 文件可能正在写入或损坏
  }
  return null;
}

/** drawtext 水印默认字体路径 */
const DEFAULT_FONT = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc";

/**
 * 录像器
 * 通过 EventBus 接收帧数据，用 ffmpeg pipe 输入编码为 MP4
 * 不单独拉 RTSP 流，复用帧提取器的唯一连接
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
  /** 过期录像清理定时器 */
  private purgeTimer: ReturnType<typeof setInterval> | null = null;
  /** 存储文件系统（增量统计） */
  private storageFs: StorageFs | null;
  /** 每路摄像头的帧预缓冲区（motion 触发前保留 ~2 秒帧） */
  private preBuffers = new Map<string, FrameRingBuffer>();

  constructor(storagePath: string, ffmpegPath: string, private eventBus: EventBus, runtimeConfig: RuntimeConfig, storageFs?: StorageFs) {
    this.storagePath = storagePath;
    this.ffmpegPath = ffmpegPath;
    this.runtimeConfig = runtimeConfig;
    this.storageFs = storageFs ?? null;
    mkdirSync(storagePath, { recursive: true });
  }

  /** 注册摄像头名称（水印用） */
  registerCameraName(cameraId: string, name: string): void {
    this.cameraNames.set(cameraId, name);
  }

  /** 移除摄像头 */
  unregisterStream(cameraId: string): void {
    this.forceStop(cameraId);
    this.preBuffers.delete(cameraId);
    this.states.delete(cameraId);
  }

  /** 启动：订阅帧事件 + 根据模式初始化录制 */
  start(): void {
    /** 订阅帧事件，写入正在录像的 ffmpeg 进程 */
    this.unsubFrame = this.eventBus.on("frame", ({ cameraId, data }) => {
      this.writeFrame(cameraId, data);
    });

    const mode = this.runtimeConfig.get().recording.mode;
    if (mode === "continuous") {
      /** 持续录制模式延迟启动（等帧提取器连接成功后再开始） */
      setTimeout(() => {
        for (const [cameraId] of this.cameraNames) {
          this.startContinuous(cameraId);
        }
      }, 3000);
    } else {
      /** 变动触发模式 */
      this.unsubMotion = this.eventBus.on("motion", ({ cameraId, timestamp }) => {
        const state = this.getOrCreateState(cameraId);
        state.lastMotionTime = timestamp;

        if (!state.recording) {
          this.startRecording(cameraId, timestamp);
        } else {
          this.scheduleStop(cameraId);
        }
      });
    }

    /** 定期清理过期录像 */
    this.purgeTimer = setInterval(() => this.purgeOldRecordings(), 3600_000);
  }

  /** 停止所有录像 */
  stop(): void {
    if (this.unsubFrame) {
      this.unsubFrame();
      this.unsubFrame = null;
    }
    if (this.unsubMotion) {
      this.unsubMotion();
      this.unsubMotion = null;
    }
    if (this.purgeTimer) {
      clearInterval(this.purgeTimer);
      this.purgeTimer = null;
    }
    for (const [cameraId] of this.states) {
      this.forceStop(cameraId);
    }
  }

  /** 运行时切换录制模式 */
  reloadMode(): void {
    const mode = this.runtimeConfig.get().recording.mode;
    console.log(`[Recorder] 模式切换: ${mode}`);

    if (mode === "continuous") {
      /** 切到持续录制 → 取消 motion 监听 */
      if (this.unsubMotion) {
        this.unsubMotion();
        this.unsubMotion = null;
      }
      for (const [cameraId] of this.states) {
        const state = this.states.get(cameraId);
        if (state?.stopTimer) {
          clearTimeout(state.stopTimer);
          state.stopTimer = null;
        }
      }
      for (const [cameraId] of this.cameraNames) {
        this.startContinuous(cameraId);
      }
    } else {
      /** 切到变动触发 → 取消持续录制，注册 motion 监听 */
      for (const [cameraId] of this.states) {
        const state = this.states.get(cameraId);
        if (state?.continuousTimer) {
          clearTimeout(state.continuousTimer);
          state.continuousTimer = null;
        }
      }
      if (!this.unsubMotion) {
        this.unsubMotion = this.eventBus.on("motion", ({ cameraId, timestamp }) => {
          const state = this.getOrCreateState(cameraId);
          state.lastMotionTime = timestamp;
          if (!state.recording) {
            this.startRecording(cameraId, timestamp);
          } else {
            this.scheduleStop(cameraId);
          }
        });
      }
    }
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
        /** auto：尝试硬件加速，失败回退 libx264 */
        return ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-pix_fmt", "yuv420p"];
    }
  }

  /** 录像帧写入节流间隔（~15fps） */
  private static readonly WRITE_THROTTLE_MS = 67;

  /** 将帧数据写入录像进程 */
  private writeFrame(cameraId: string, jpegData: Buffer): void {
    const state = this.states.get(cameraId);
    const now = Date.now();

    if (!state?.recording || !state.proc?.stdin?.writable || state.writing) {
      /** 不在录像状态 → 缓存到预缓冲区（motion 触发模式） */
      if (this.runtimeConfig.get().recording.mode !== "continuous") {
        let buf = this.preBuffers.get(cameraId);
        if (!buf) {
          buf = new FrameRingBuffer(30);
          this.preBuffers.set(cameraId, buf);
        }
        /** 预缓冲也做帧率节流 */
        if (now - (state?.lastWriteTime ?? 0) >= MotionRecorder.WRITE_THROTTLE_MS) {
          buf.push(jpegData, now);
        }
      }
      return;
    }

    /** 帧率节流：避免双流模式下 HD 高帧率写入过多帧 */
    if (now - state.lastWriteTime < MotionRecorder.WRITE_THROTTLE_MS) return;
    state.lastWriteTime = now;

    state.writing = true;
    state.proc.stdin.write(jpegData, () => {
      state.writing = false;
    });
  }

  /** 录像列表缓存（TTL 5 秒，避免频繁 stat 文件系统） */
  private listCache = new Map<string, { data: RecordingInfo[]; expiry: number }>();
  private static readonly LIST_CACHE_TTL = 30_000;

  /** 列出录像文件 */
  listRecordings(cameraId?: string, since?: number, until?: number): RecordingInfo[] {
    /** 检查缓存 */
    const cacheKey = `${cameraId ?? ""}:${since ?? 0}:${until ?? 0}`;
    const cached = this.listCache.get(cacheKey);
    if (cached && Date.now() < cached.expiry) return cached.data;

    const results: RecordingInfo[] = [];

    const scanDir = cameraId ? join(this.storagePath, cameraId) : this.storagePath;
    let dirs: string[];

    try {
      if (cameraId) {
        dirs = [scanDir];
      } else {
        dirs = readdirSync(this.storagePath)
          .filter(f => statSync(join(this.storagePath, f)).isDirectory())
          .map(f => join(this.storagePath, f));
      }
    } catch {
      return results;
    }

    for (const dir of dirs) {
      const camId = cameraId ?? dir.split("/").pop()!;
      let files: string[];
      try {
        files = readdirSync(dir);
      } catch {
        continue;
      }

      for (const file of files) {
        if (!file.endsWith(".mp4")) continue;
        const filePath = join(dir, file);
        const stat = statSync(filePath);
        const parsed = this.parseFilename(file);
        const rec: RecordingInfo = {
          filename: `${camId}/${file}`,
          cameraId: camId,
          startTime: parsed.startTime,
          endTime: parsed.endTime ?? ((): number => {
            const dur = parseMp4DurationMs(filePath);
            return dur ? parsed.startTime + dur : stat.mtimeMs;
          })(),
          size: stat.size,
        };
        if (since && rec.endTime < since) continue;
        if (until && rec.startTime > until) continue;
        results.push(rec);
      }
    }

    const sorted = results.sort((a, b) => b.startTime - a.startTime);
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

  /** 开始录像（变动触发模式） */
  private startRecording(cameraId: string, timestamp: number): void {
    this.startRecordingInternal(cameraId, timestamp);
  }

  /** 启动录像：通过 ffmpeg pipe 接收 JPEG 帧并编码为 MP4 */
  private startRecordingInternal(cameraId: string, timestamp: number): void {
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
    const dir = join(this.storagePath, cameraId);
    mkdirSync(dir, { recursive: true });
    const outputPath = join(dir, filename);

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

      /** 清理空或异常小的录像文件（< 1KB 视为无效） */
      try {
        const stat = statSync(outputPath);
        if (stat.size < 1024) {
          if (this.storageFs) {
            this.storageFs.deleteFile(`recordings/${cameraId}/${filename}`);
          } else {
            unlinkSync(outputPath);
          }
          console.warn(`[Recorder] ${cameraId} 清理无效录像: ${filename} (${stat.size} bytes)`);
          this.listCache.clear();
          return;
        }
      } catch {
        // file may not exist
      }

      /** 记录有效录像文件增量 */
      if (this.storageFs && code === 0) {
        try {
          const stat = statSync(outputPath);
          if (stat.size >= 1024) {
            this.storageFs.diskUsage.recordAdd("recordings", stat.size);
          }
        } catch { /* */ }
      }

      /** 连续录制模式下非正常退出：3 秒后自动重启（避免长时间无录像） */
      if (code !== 0 && state.continuousTimer) {
        /** 清理旧的分段定时器，避免与重启后的定时器冲突 */
        clearTimeout(state.continuousTimer);
        state.continuousTimer = null;
        console.warn(`[Recorder] ${cameraId} ffmpeg 异常退出 (code=${code})，3 秒后重启连续录制`);
        setTimeout(() => {
          /** 确认仍然处于连续录制模式（用户未手动停止） */
          if (!state.continuousTimer && !state.recording) {
            this.startContinuous(cameraId);
          }
        }, 3000);
      }
    });

    state.recording = true;
    state.proc = proc;
    state.startTime = timestamp;

    /** 写入预缓冲帧（motion 触发前的帧，确保不丢失触发瞬间的画面） */
    const preBuffer = this.preBuffers.get(cameraId);
    if (preBuffer) {
      const frames = preBuffer.drain();
      if (frames.length > 0) {
        console.log(`[Recorder] ${cameraId} 写入预缓冲帧: ${frames.length} 帧`);
        for (const frame of frames) {
          proc.stdin?.write(frame.data);
        }
      }
    }
  }

  /** 延迟停止录像（最后一次 motion 后等待一段时间） */
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

  /** 清理过期录像（可传入自定义保留天数，用于磁盘感知加速清理） */
  purgeOldRecordings(overrideRetentionDays?: number): void {
    const retentionDays = overrideRetentionDays ?? this.runtimeConfig.get().recording.retentionDays;
    const cutoff = Date.now() - retentionDays * 86400_000;

    try {
      const camDirs = readdirSync(this.storagePath);
      for (const camDir of camDirs) {
        const camPath = join(this.storagePath, camDir);
        if (!statSync(camPath).isDirectory()) continue;

        const files = readdirSync(camPath);
        for (const file of files) {
          if (!file.endsWith(".mp4")) continue;
          const filePath = join(camPath, file);
          const stat = statSync(filePath);
          if (stat.mtimeMs < cutoff) {
            if (this.storageFs) {
              this.storageFs.deleteFile(`recordings/${camDir}/${file}`);
            } else {
              unlinkSync(filePath);
            }
            console.log(`[Recorder] 清理过期录像: ${camDir}/${file}`);
          }
        }
      }
    } catch {
      // ignore
    }
    /** 清理后使缓存失效 */
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

    const state: RecordingState = { proc: null, recording: false, lastMotionTime: 0, startTime: 0, stopTimer: null, continuousTimer: null, writing: false, lastWriteTime: 0 };
    this.states.set(cameraId, state);
    return state;
  }
}
