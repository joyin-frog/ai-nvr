import { spawn } from "node:child_process";

/** 最大回溯时长（秒） */
const MAX_CLIP_LOOKBACK = 300;
/** 最大帧数 */
const MAX_CLIP_FRAMES = 20;
/** 最大帧率 */
const MAX_CLIP_FPS = 5;
/** 单帧 ffmpeg 超时（ms） */
const SINGLE_FRAME_TIMEOUT_MS = 5_000;
/** 最大并发 ffmpeg 进程数 */
const MAX_CONCURRENT = 2;

/** 抽帧参数 */
export interface ClipExtractionParams {
  /** 录制文件绝对路径列表（按时间排序） */
  recordingPaths: string[];
  /** 每个录制文件的起始时间 (ms) */
  recordingStartTimes: number[];
  /** 要抽取的时间窗口起始 (ms) */
  windowStartMs: number;
  /** 要抽取的时间窗口结束 (ms) */
  windowEndMs: number;
  /** 抽帧模式 */
  frameMode: "fps" | "total";
  /** fps 模式：每秒帧数 */
  fps?: number;
  /** total 模式：总帧数 */
  totalFrames?: number;
  /** 目标宽度（0=不缩放） */
  targetWidth: number;
  /** ffmpeg 路径 */
  ffmpegPath: string;
}

/** 抽帧结果 */
export interface ClipExtractionResult {
  frames: Array<{ data: Buffer; timestamp: number }>;
  /** 是否因录制文件缺失导致帧数不足 */
  incomplete: boolean;
}

/** 并发控制状态 */
let concurrent = 0;
const queue: Array<{ resolve: () => void }> = [];

function acquire(): Promise<void> {
  if (concurrent < MAX_CONCURRENT) {
    concurrent++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    queue.push({ resolve: () => { concurrent++; resolve(); } });
  });
}

function release(): void {
  concurrent--;
  const next = queue.shift();
  if (next) next.resolve();
}

/** 计算均匀分布的目标时间点 */
function computeTargetTimestamps(params: ClipExtractionParams): number[] {
  const { windowStartMs, windowEndMs, frameMode, fps, totalFrames } = params;
  const durationMs = windowEndMs - windowStartMs;
  if (durationMs <= 0) return [windowStartMs];

  let count: number;
  if (frameMode === "fps") {
    const clampedFps = Math.min(fps ?? 1, MAX_CLIP_FPS);
    count = Math.min(Math.ceil((durationMs / 1000) * clampedFps), MAX_CLIP_FRAMES);
  } else {
    count = Math.min(totalFrames ?? 5, MAX_CLIP_FRAMES);
  }
  count = Math.max(count, 1);

  if (count === 1) return [windowStartMs + durationMs / 2];

  const timestamps: number[] = [];
  const interval = durationMs / (count - 1);
  for (let i = 0; i < count; i++) {
    timestamps.push(windowStartMs + interval * i);
  }
  return timestamps;
}

/** 用 ffmpeg 抽取单个时间点的 JPEG 帧（pipe 模式，不落盘） */
function captureFrame(
  ffmpegPath: string, filePath: string, seekSec: number, targetWidth: number,
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const args: string[] = [
      "-ss", String(Math.max(0, seekSec)),
      "-i", filePath,
      "-frames:v", "1",
      "-f", "image2pipe",
      "-vcodec", "mjpeg",
      "-q:v", "5",
      "-an",
      "pipe:1",
    ];
    if (targetWidth > 0) {
      args.splice(args.length - 2, 0, "-vf", `scale=${targetWidth}:-2`);
    }

    const proc = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    proc.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));

    const timer = setTimeout(() => {
      proc.stdout?.destroy();
      proc.kill("SIGKILL");
      proc.unref();
      resolve(null);
    }, SINGLE_FRAME_TIMEOUT_MS);

    proc.on("exit", () => {
      clearTimeout(timer);
      proc.unref();
      const buf = Buffer.concat(chunks);
      resolve(buf.length > 100 ? buf : null);
    });
    proc.on("error", () => {
      clearTimeout(timer);
      proc.unref();
      resolve(null);
    });
  });
}

/**
 * 从录制文件中抽取指定时间窗口的帧
 *
 * @param params 抽帧参数
 * @param recordingEndTimes 每个录制文件的结束时间 (ms)，用于判断文件是否覆盖目标时间点
 */
export async function extractClipFrames(
  params: ClipExtractionParams,
  recordingEndTimes: number[],
): Promise<ClipExtractionResult> {
  const targetTimestamps = computeTargetTimestamps(params);
  const frames: Array<{ data: Buffer; timestamp: number }> = [];
  let incomplete = false;

  for (const targetTs of targetTimestamps) {
    /** 找到覆盖此时间点的录制文件 */
    let foundIdx = -1;
    for (let i = 0; i < params.recordingPaths.length; i++) {
      const start = params.recordingStartTimes[i]!;
      const end = recordingEndTimes[i]!;
      if (targetTs >= start && targetTs <= end) {
        foundIdx = i;
        break;
      }
    }

    if (foundIdx < 0) {
      incomplete = true;
      continue;
    }

    const filePath = params.recordingPaths[foundIdx]!;
    const fileStartMs = params.recordingStartTimes[foundIdx]!;
    const seekSec = (targetTs - fileStartMs) / 1000;

    await acquire();
    try {
      const jpeg = await captureFrame(params.ffmpegPath, filePath, seekSec, params.targetWidth);
      if (jpeg) {
        frames.push({ data: jpeg, timestamp: targetTs });
      } else {
        incomplete = true;
      }
    } finally {
      release();
    }
  }

  return { frames, incomplete };
}

/** 获取安全限制常量（供外部校验使用） */
export const CLIP_LIMITS = {
  maxLookbackSec: MAX_CLIP_LOOKBACK,
  maxFrames: MAX_CLIP_FRAMES,
  maxFps: MAX_CLIP_FPS,
} as const;
