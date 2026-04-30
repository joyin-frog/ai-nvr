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
}

/**
 * 变动触发录像器
 * 监听 motion 事件，直接从主码流 RTSP 拉流录像（高质量）
 * 不再依赖 frame pipe，录像与预览/检测完全解耦
 */
export class MotionRecorder {
  private config: RecorderConfig;
  private states = new Map<string, RecordingState>();
  /** 摄像头 ID → 主码流 RTSP URL */
  private hdStreams = new Map<string, string>();

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

  /** 注册摄像头的主码流 RTSP 地址 */
  registerStream(cameraId: string, hdUrl: string): void {
    this.hdStreams.set(cameraId, hdUrl);
  }

  /** 移除摄像头 */
  unregisterStream(cameraId: string): void {
    this.forceStop(cameraId);
    this.hdStreams.delete(cameraId);
  }

  /** 启动：监听 motion 事件 */
  start(): void {
    /** motion 事件触发开始/延续录像 */
    this.eventBus.on("motion", ({ cameraId, timestamp }) => {
      const state = this.getOrCreateState(cameraId);
      state.lastMotionTime = timestamp;

      if (!state.recording) {
        this.startRecording(cameraId, timestamp);
      } else {
        /** 已在录像：取消之前的停止定时器，重新设置延迟停止 */
        this.scheduleStop(cameraId);
      }
    });

    /** 定期清理过期录像 */
    setInterval(() => this.purgeOldRecordings(), 3600_000);
  }

  /** 停止所有录像 */
  stop(): void {
    for (const [cameraId] of this.states) {
      this.forceStop(cameraId);
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

  /** 开始录像：直接从主码流 RTSP 拉流 */
  private startRecording(cameraId: string, timestamp: number): void {
    const hdUrl = this.hdStreams.get(cameraId);
    if (!hdUrl) {
      console.warn(`[Recorder] ${cameraId} 无主码流地址，跳过录像`);
      return;
    }

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

    /** 直接从 RTSP 主码流转码保存为 MP4 */
    const args = [
      "-rtsp_transport", "tcp",
      "-i", hdUrl,
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "-an",
      "-t", String(this.config.maxSegmentDuration),
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
      state.recording = false;
      state.proc = null;
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
      /** 发送 q 命令优雅停止 ffmpeg（让它正常关闭输出文件） */
      if (state.proc) {
        state.proc.stdin?.end();
        /** 如果 ffmpeg 是从 RTSP 拉流（stdin 无用），用 SIGTERM 优雅退出 */
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
    if (state.proc) {
      state.proc.kill("SIGTERM");
      state.proc = null;
    }
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

    const state: RecordingState = { proc: null, recording: false, lastMotionTime: 0, startTime: 0, stopTimer: null };
    this.states.set(cameraId, state);
    return state;
  }
}
