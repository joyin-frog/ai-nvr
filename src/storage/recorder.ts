import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { type EventBus } from "@/event-bus";
import { type RuntimeConfig } from "@/runtime-config";

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

/** 录像器配置 */
interface RecorderConfig {
  /** 存储目录 */
  storagePath: string;
  /** ffmpeg 路径 */
  ffmpegPath: string;
  /** 无运动后继续录制的时长（ms） */
  postMotionDuration: number;
  /** 单个片段最大时长（秒） */
  maxSegmentDuration: number;
  /** 自动清理天数 */
  retentionDays: number;
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
}

/**
 * 录像器
 * 支持两种模式：变动触发录像（motion）和持续录制（continuous）
 * 直接从主码流 RTSP 拉流录像（高质量），与预览/检测解耦
 */
/** drawtext 水印默认字体路径 */
const DEFAULT_FONT = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc";

export class MotionRecorder {
  private config: RecorderConfig;
  private states = new Map<string, RecordingState>();
  /** 摄像头 ID → 主码流 RTSP URL */
  private hdStreams = new Map<string, string>();
  /** 摄像头 ID → 友好名称（水印用） */
  private cameraNames = new Map<string, string>();
  private runtimeConfig: RuntimeConfig;

  constructor(storagePath: string, ffmpegPath: string, private eventBus: EventBus, runtimeConfig: RuntimeConfig) {
    this.config = {
      storagePath,
      ffmpegPath,
      postMotionDuration: 5000,
      maxSegmentDuration: 300,
      retentionDays: 7,
    };
    this.runtimeConfig = runtimeConfig;
    mkdirSync(storagePath, { recursive: true });
  }

  /** 注册摄像头的主码流 RTSP 地址 */
  registerStream(cameraId: string, hdUrl: string): void {
    this.hdStreams.set(cameraId, hdUrl);
    /** 如果是持续录制模式且已在运行，立即开始录制 */
    if (this.runtimeConfig.get().recording.mode === "continuous") {
      this.startContinuous(cameraId);
    }
  }

  /** 注册摄像头友好名称（水印用） */
  registerCameraName(cameraId: string, name: string): void {
    this.cameraNames.set(cameraId, name);
  }

  /** 移除摄像头 */
  unregisterStream(cameraId: string): void {
    this.forceStop(cameraId);
    this.hdStreams.delete(cameraId);
  }

  /** 持续录制：启动一段录制，到时后自动开始下一段 */
  startContinuous(cameraId: string): void {
    const state = this.getOrCreateState(cameraId);
    if (state.recording) return;

    const segmentSec = this.runtimeConfig.get().recording.segmentDuration;
    const now = Date.now();

    this.startRecordingInternal(cameraId, now, segmentSec);

    /** 设置分段定时器，到达分段时长后重启下一段 */
    state.continuousTimer = setTimeout(() => {
      this.forceStop(cameraId);
      /** 立即开始下一段 */
      this.startContinuous(cameraId);
    }, segmentSec * 1000);
  }

  /** 启动：根据模式初始化录制 */
  start(): void {
    const mode = this.runtimeConfig.get().recording.mode;

    if (mode === "continuous") {
      /** 持续录制模式：为所有已注册的摄像头开始录制 */
      for (const [cameraId] of this.hdStreams) {
        this.startContinuous(cameraId);
      }
      /** 监听新注册的摄像头（通过 motion 事件间接触发） */
    } else {
      /** 变动触发模式 */
      this.eventBus.on("motion", ({ cameraId, timestamp }) => {
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
    setInterval(() => this.purgeOldRecordings(), 3600_000);
  }

  /** 停止所有录像 */
  stop(): void {
    for (const [cameraId] of this.states) {
      this.forceStop(cameraId);
    }
  }

  /** 运行时切换录制模式（API 修改设置后调用） */
  reloadMode(): void {
    const mode = this.runtimeConfig.get().recording.mode;
    console.log(`[Recorder] 模式切换: ${mode}`);

    if (mode === "continuous") {
      /** 停止所有 motion 定时器，启动持续录制 */
      for (const [cameraId] of this.states) {
        const state = this.states.get(cameraId);
        if (state?.stopTimer) {
          clearTimeout(state.stopTimer);
          state.stopTimer = null;
        }
      }
      for (const [cameraId] of this.hdStreams) {
        this.startContinuous(cameraId);
      }
    } else {
      /** 停止所有持续录制定时器，当前段自然结束后不再重启 */
      for (const [cameraId] of this.states) {
        const state = this.states.get(cameraId);
        if (state?.continuousTimer) {
          clearTimeout(state.continuousTimer);
          state.continuousTimer = null;
        }
      }
    }
  }

  /** 列出录像文件 */
  listRecordings(cameraId?: string, since?: number, until?: number): RecordingInfo[] {
    const results: RecordingInfo[] = [];

    const scanDir = cameraId ? join(this.config.storagePath, cameraId) : this.config.storagePath;
    let dirs: string[];

    try {
      if (cameraId) {
        dirs = [scanDir];
      } else {
        dirs = readdirSync(this.config.storagePath)
          .filter(f => statSync(join(this.config.storagePath, f)).isDirectory())
          .map(f => join(this.config.storagePath, f));
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
        /** 文件名格式：2026-05-01_14-30-00.mp4 */
        const parsed = this.parseFilename(file);
        const rec: RecordingInfo = {
          filename: `${camId}/${file}`,
          cameraId: camId,
          startTime: parsed.startTime,
          endTime: parsed.endTime ?? stat.mtimeMs,
          size: stat.size,
        };
        /** 时间范围过滤：录像时间段与查询范围有交集 */
        if (since && rec.endTime < since) continue;
        if (until && rec.startTime > until) continue;
        results.push(rec);
      }
    }

    return results.sort((a, b) => b.startTime - a.startTime);
  }

  /** 获取录像文件路径 */
  getRecordingPath(relativePath: string): string {
    return join(this.config.storagePath, relativePath);
  }

  /** 获取所有摄像头的当前录像状态 */
  getRecordingStates(): Array<{ cameraId: string; recording: boolean; startTime: number }> {
    const result: Array<{ cameraId: string; recording: boolean; startTime: number }> = [];
    for (const [cameraId, state] of this.states) {
      result.push({ cameraId, recording: state.recording, startTime: state.startTime });
    }
    return result;
  }

  /** 开始录像（变动触发模式，使用 maxSegmentDuration 上限） */
  private startRecording(cameraId: string, timestamp: number): void {
    this.startRecordingInternal(cameraId, timestamp, this.config.maxSegmentDuration);
  }

  /** 开始录像：直接从主码流 RTSP 拉流 */
  private startRecordingInternal(cameraId: string, timestamp: number, durationSec: number): void {
    const hdUrl = this.hdStreams.get(cameraId);
    if (!hdUrl) {
      console.warn(`[Recorder] ${cameraId} 无主码流地址，跳过录像`);
      return;
    }

    const state = this.getOrCreateState(cameraId);

    /** 防御性清理：如果旧 ffmpeg 进程还在运行，先 kill */
    if (state.proc) {
      state.proc.kill("SIGKILL");
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
    const dir = join(this.config.storagePath, cameraId);
    mkdirSync(dir, { recursive: true });
    const outputPath = join(dir, filename);

    /** 构建 drawtext 水印滤镜 */
    const wm = this.runtimeConfig.get().recording.watermark;
    const filterParts: string[] = [];
    if (wm.enabled) {
      const camName = this.cameraNames.get(cameraId);
      /** 根据位置计算 drawtext x/y 坐标 */
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

    const args = [
      "-rtsp_transport", "tcp",
      "-i", hdUrl,
      ...(filterParts.length > 0 ? ["-vf", filterParts.join(",")] : []),
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "-an",
      "-t", String(durationSec),
      "-y",
      outputPath,
    ];

    console.log(`[Recorder] ${cameraId} 开始录像 (主码流): ${filename}`);
    const proc = spawn(this.config.ffmpegPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg.includes("error") || msg.includes("Error")) {
        console.error(`[Recorder] ${cameraId} ffmpeg error:`, msg);
      }
    });

    proc.on("exit", (code) => {
      console.log(`[Recorder] ${cameraId} 录像结束, code=${code}`);
      /** 只清理未被覆盖的 proc 引用 */
      if (state.proc === proc) {
        state.proc = null;
      }
      state.recording = false;
    });

    state.recording = true;
    state.proc = proc;
    state.startTime = timestamp;
  }

  /** 延迟停止录像（最后一次 motion 后等待一段时间） */
  private scheduleStop(cameraId: string): void {
    const state = this.states.get(cameraId);
    if (!state?.recording) return;

    if (state.stopTimer) {
      clearTimeout(state.stopTimer);
    }

    state.stopTimer = setTimeout(() => {
      /** SIGTERM 让 ffmpeg 优雅退出（写入 MP4 文件尾） */
      if (state.proc) {
        state.proc.kill("SIGTERM");
      }
      state.stopTimer = null;
      console.log(`[Recorder] ${cameraId} 停止录像（无运动超时）`);
    }, this.config.postMotionDuration);
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
      oldProc.kill("SIGTERM");
    }
    state.recording = false;
  }

  /** 清理过期录像 */
  private purgeOldRecordings(): void {
    const cutoff = Date.now() - this.config.retentionDays * 86400_000;

    try {
      const camDirs = readdirSync(this.config.storagePath);
      for (const camDir of camDirs) {
        const camPath = join(this.config.storagePath, camDir);
        if (!statSync(camPath).isDirectory()) continue;

        const files = readdirSync(camPath);
        for (const file of files) {
          if (!file.endsWith(".mp4")) continue;
          const filePath = join(camPath, file);
          const stat = statSync(filePath);
          if (stat.mtimeMs < cutoff) {
            unlinkSync(filePath);
            console.log(`[Recorder] 清理过期录像: ${camDir}/${file}`);
          }
        }
      }
    } catch {
      // ignore
    }
  }

  /** 解析录像文件名获取时间信息 */
  private parseFilename(filename: string): { startTime: number; endTime: number | null } {
    /** 格式：2026-05-01_14-30-00.mp4 */
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

    const state: RecordingState = { proc: null, recording: false, lastMotionTime: 0, startTime: 0, stopTimer: null, continuousTimer: null };
    this.states.set(cameraId, state);
    return state;
  }
}
