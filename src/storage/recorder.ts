import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { type EventBus } from "@/event-bus";

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
  /** 当前正在运行的 ffmpeg 进程 */
  proc: ReturnType<typeof spawn> | null;
  /** 是否正在录像 */
  recording: boolean;
  /** 最后一次 motion 时间 */
  lastMotionTime: number;
  /** 当前录像开始时间 */
  startTime: number;
  /** 停止定时器 */
  stopTimer: ReturnType<typeof setTimeout> | null;
  /** 帧缓冲（录像未启动时缓存最近帧） */
  frameBuffer: Buffer[];
}

/**
 * 变动触发录像器
 * 监听 motion 事件启动 ffmpeg 录像，无变动后延迟停止
 * 使用 ffmpeg 的 image2pipe 输入方式将帧编码为 MP4 片段
 */
export class MotionRecorder {
  private config: RecorderConfig;
  private states = new Map<string, RecordingState>();

  constructor(storagePath: string, ffmpegPath: string, private eventBus: EventBus) {
    this.config = {
      storagePath,
      ffmpegPath,
      postMotionDuration: 5000,
      maxSegmentDuration: 300,
      retentionDays: 7,
    };
    mkdirSync(storagePath, { recursive: true });
  }

  /** 启动：监听 motion 和 frame 事件 */
  start(): void {
    /** motion 事件触发开始/延续录像 */
    this.eventBus.on("motion", ({ cameraId, data, timestamp }) => {
      const state = this.getOrCreateState(cameraId);
      state.lastMotionTime = timestamp;

      if (!state.recording) {
        this.startRecording(cameraId, timestamp);
      }
    });

    /** frame 事件喂给正在运行的 ffmpeg */
    this.eventBus.on("frame", ({ cameraId, data }) => {
      const state = this.states.get(cameraId);
      if (!state?.recording || !state.proc) return;

      const stdin = state.proc.stdin;
      if (stdin?.writable) {
        stdin.write(data);
      }
    });

    /** 定期清理过期录像 */
    setInterval(() => this.purgeOldRecordings(), 3600_000);
  }

  /** 停止所有录像 */
  stop(): void {
    for (const [cameraId] of this.states) {
      this.stopRecording(cameraId);
    }
  }

  /** 列出录像文件 */
  listRecordings(cameraId?: string): RecordingInfo[] {
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
        results.push({
          filename: `${camId}/${file}`,
          cameraId: camId,
          startTime: parsed.startTime,
          endTime: parsed.endTime ?? stat.mtimeMs,
          size: stat.size,
        });
      }
    }

    return results.sort((a, b) => b.startTime - a.startTime);
  }

  /** 获取录像文件路径 */
  getRecordingPath(relativePath: string): string {
    return join(this.config.storagePath, relativePath);
  }

  /** 开始录像 */
  private startRecording(cameraId: string, timestamp: number): void {
    const state = this.getOrCreateState(cameraId);

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

    /** 用 ffmpeg 将 JPEG 帧流编码为 MP4 */
    const args = [
      "-f", "image2pipe",
      "-vcodec", "mjpeg",
      "-framerate", "5",
      "-i", "pipe:0",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "28",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "-t", String(this.config.maxSegmentDuration),
      "-y",
      outputPath,
    ];

    console.log(`[Recorder] ${cameraId} 开始录像: ${filename}`);
    const proc = spawn(this.config.ffmpegPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg.includes("error") || msg.includes("Error")) {
        console.error(`[Recorder] ${cameraId} ffmpeg error:`, msg);
      }
    });

    proc.on("exit", (code) => {
      console.log(`[Recorder] ${cameraId} 录像结束, code=${code}`);
      state.recording = false;
      state.proc = null;
    });

    state.recording = true;
    state.proc = proc;
    state.startTime = timestamp;
  }

  /** 延迟停止录像（最后一次 motion 后等待一段时间） */
  private stopRecording(cameraId: string): void {
    const state = this.states.get(cameraId);
    if (!state?.recording) return;

    if (state.stopTimer) {
      clearTimeout(state.stopTimer);
    }

    state.stopTimer = setTimeout(() => {
      if (state.proc) {
        state.proc.stdin?.end();
      }
      state.stopTimer = null;
      console.log(`[Recorder] ${cameraId} 停止录像（无运动超时）`);
    }, this.config.postMotionDuration);
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
    let state = this.states.get(cameraId);
    if (!state) {
      state = { proc: null, recording: false, lastMotionTime: 0, startTime: 0, stopTimer: null, frameBuffer: [] };
      this.states.set(cameraId, state);
    }
    return state;
  }
}
