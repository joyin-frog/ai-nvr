import { type Observer, type CameraSource, type PreparedFrames, type FrameProvider } from "@/observer/types";
import { extractClipFrames, CLIP_LIMITS } from "@/observer/clip-extractor";
import { type RoiStorage } from "@/storage/roi";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { resizeToDataUrl, resizeToBuffer as sharedResizeToBuffer } from "@/ai/image-utils";

/** Recorder 接口（用于获取上下文帧和录制文件查询） */
export interface Recorder {
  getContextFrames(cameraId: string, now: number, intervalMs: number, maxFrames?: number): Array<{ data: Buffer; timestamp: number }>;
  listRecordings(cameraId?: string, since?: number, until?: number): Array<{ filename: string; cameraId: string; startTime: number; endTime: number; size: number }>;
  getRecordingPath(relativePath: string): string;
}

/** 帧准备配置 */
export interface FramePrepConfig {
  contextIntervalMs: number;
}

/**
 * 帧准备模块
 */
export class FramePrep {
  private recorder?: Recorder;
  private ffmpegPath = "";
  private refImagesDir = "";

  constructor(
    private frameProvider: FrameProvider,
    private roiStorage?: RoiStorage,
  ) {}

  setRecorder(rec: Recorder): void { this.recorder = rec; }
  setFfmpegPath(path: string): void { this.ffmpegPath = path; }
  setRefImagesDir(dir: string): void { this.refImagesDir = dir; }

  async prepare(
    obs: Observer,
    primaryFrame: Buffer,
    timestamp: number,
    imageWidth: number,
    config: FramePrepConfig,
  ): Promise<PreparedFrames> {
    const primaryCam = obs.cameras[0];
    const resizeImage = this.createResizer(imageWidth);

    /** 主摄像头图片：先缩放 */
    let resized = await this.resizeToBuffer(primaryFrame, imageWidth);

    /** 再裁剪 ROI（在缩放后的图上操作，效率更高） */
    let processed = resized;
    if (primaryCam && primaryCam.roiId > 0 && this.roiStorage) {
      processed = await this.cropToRoi(resized, primaryCam.roiId) ?? resized;
    }

    const primaryDataUrl = `data:image/jpeg;base64,${processed.toString("base64")}`;

    const userContent: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
    userContent.push({ type: "text", text: obs.prompt });
    userContent.push({ type: "image_url", image_url: { url: primaryDataUrl } });

    /** 获取上下文帧 */
    let hasContext = false;
    if (this.recorder && config.contextIntervalMs > 0 && primaryCam) {
      const contextFrames = this.recorder.getContextFrames(primaryCam.cameraId, timestamp, config.contextIntervalMs);
      if (contextFrames.length > 0) {
        hasContext = true;
        const ctxUrls = await Promise.all(contextFrames.map(f => resizeImage(f.data)));
        for (let i = 0; i < contextFrames.length; i++) {
          const agoSec = Math.round((timestamp - contextFrames[i]!.timestamp) / 1000);
          userContent.push({ type: "text", text: `${agoSec}s ago:` });
          userContent.push({ type: "image_url", image_url: { url: ctxUrls[i]! } });
        }
      }
    }

    /** 多摄像头时也算 hasContext */
    if (obs.cameras.length > 1) hasContext = true;

    /**
     * 各摄像头帧
     * original: 原始帧（用于历史面板展示原图，不做裁剪）
     * processed: 实际发给 AI 的帧（缩放+ROI裁剪后，用于历史面板展示 AI 输入图+存储）
     */
    const cameraFrames = new Map<string, { original: Buffer; processed: Buffer }>();
    if (primaryCam) {
      cameraFrames.set(primaryCam.cameraId, { original: primaryFrame, processed });
    }

    /** 附加其他摄像头源帧 */
    for (const src of obs.cameras.slice(1)) {
      if (src.videoClip) {
        await this.appendVideoClipFrames(src, timestamp, imageWidth, userContent);
      } else {
        await this.appendSingleFrame(src, timestamp, imageWidth, cameraFrames, userContent);
      }
    }

    /** 附加参考图片 */
    if (obs.refImages.length > 0 && this.refImagesDir) {
      for (const imgName of obs.refImages) {
        const imgPath = join(this.refImagesDir, imgName);
        const imgData = await readFile(imgPath).catch(() => null);
        if (imgData) {
          const refUrl = await resizeImage(imgData);
          userContent.push({ type: "text", text: "[Reference image]" });
          userContent.push({ type: "image_url", image_url: { url: refUrl } });
        }
      }
    }

    return { primaryDataUrl, hasContext, userContent, cameraFrames };
  }

  /** 缩放图片并返回 Buffer（用于后续 ROI 裁剪） */
  private resizeToBuffer = sharedResizeToBuffer;

  createResizer(imageWidth: number): (img: Buffer) => Promise<string> {
    return (img: Buffer) => resizeToDataUrl(img, imageWidth);
  }

  async cropToRoi(frame: Buffer, roiId: number): Promise<Buffer | undefined> {
    if (!this.roiStorage) return undefined;
    const roi = this.roiStorage.getById(roiId);
    if (!roi?.points) return undefined;

    let polygon: Array<{ x: number; y: number }>;
    try {
      polygon = JSON.parse(roi.points) as Array<{ x: number; y: number }>;
    } catch (e) {
      console.warn("[FramePrep] 帧准备失败:", e);
      return undefined;
    }
    if (polygon.length < 3) return undefined;

    const meta = await sharp(frame).metadata();
    const w = meta.width ?? 640;
    const h = meta.height ?? 480;

    /** 1. 计算多边形 AABB */
    let minX = 1, minY = 1, maxX = 0, maxY = 0;
    for (const p of polygon) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }

    /** 加 5% padding */
    const padX = (maxX - minX) * 0.05;
    const padY = (maxY - minY) * 0.05;
    const cropX = Math.max(0, minX - padX);
    const cropY = Math.max(0, minY - padY);
    const cropR = Math.min(1, maxX + padX);
    const cropB = Math.min(1, maxY + padY);
    const cropW = Math.max(1, Math.round((cropR - cropX) * w));
    const cropH = Math.max(1, Math.round((cropB - cropY) * h));
    const cropLeft = Math.round(cropX * w);
    const cropTop = Math.round(cropY * h);

    /** 2. 裁剪到 AABB 矩形区域 */
    const cropped = await sharp(frame)
      .extract({ left: cropLeft, top: cropTop, width: cropW, height: cropH })
      .ensureAlpha()
      .toBuffer();

    /** 3. 构建多边形 mask（坐标相对于裁剪后的区域） */
    const maskPoints = polygon.map(p =>
      `${((p.x - cropX) * w).toFixed(1)},${((p.y - cropY) * h).toFixed(1)}`
    ).join(" ");
    const maskSvg = Buffer.from(
      `<svg width="${cropW}" height="${cropH}"><polygon points="${maskPoints}" fill="white"/></svg>`
    );

    /** 4. 用多边形 mask 将 ROI 外区域涂黑 */
    return sharp(cropped)
      .composite([{ input: maskSvg, blend: "dest-in" }])
      .flatten({ background: { r: 0, g: 0, b: 0 } })
      .jpeg({ quality: 85 })
      .toBuffer();
  }

  private async appendVideoClipFrames(
    src: CameraSource,
    timestamp: number,
    imageWidth: number,
    userContent: Array<{ type: string; text?: string; image_url?: { url: string } }>,
  ): Promise<void> {
    if (!src.videoClip || !this.recorder || !this.ffmpegPath) return;

    const { startOffsetSec, endOffsetSec } = src.videoClip;
    const clampedStart = Math.min(startOffsetSec, CLIP_LIMITS.maxLookbackSec);
    const clampedEnd = Math.max(endOffsetSec, 0);
    if (clampedStart <= clampedEnd) return;

    const windowStartMs = timestamp - clampedStart * 1000;
    const windowEndMs = timestamp - clampedEnd * 1000;

    const recordings = this.recorder.listRecordings(src.cameraId, windowStartMs, windowEndMs);
    if (recordings.length === 0) return;

    const result = await extractClipFrames(
      {
        recordingPaths: recordings.map(r => this.recorder!.getRecordingPath(r.filename)),
        recordingStartTimes: recordings.map(r => r.startTime),
        windowStartMs,
        windowEndMs,
        frameMode: src.videoClip.extraction.mode,
        fps: src.videoClip.extraction.fps,
        totalFrames: src.videoClip.extraction.totalFrames,
        targetWidth: imageWidth,
        ffmpegPath: this.ffmpegPath,
      },
      recordings.map(r => r.endTime),
    );

    if (result.incomplete) {
      console.warn(`[FramePrep] 视频片段抽帧不完整: ${src.cameraId} (${clampedStart}s~${clampedEnd}s)`);
    }

    if (result.frames.length > 0) {
      userContent.push({ type: "text", text: `[Camera: ${src.cameraId}, Video clip: ${startOffsetSec}s~${endOffsetSec}s ago, ${result.frames.length} frames]` });
      for (const f of result.frames) {
        const base64 = f.data.toString("base64");
        userContent.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64}` } });
      }
    }
  }

  private async appendSingleFrame(
    src: CameraSource,
    timestamp: number,
    imageWidth: number,
    cameraFrames: Map<string, { original: Buffer; processed: Buffer }>,
    userContent: Array<{ type: string; text?: string; image_url?: { url: string } }>,
  ): Promise<void> {
    let camFrame: Buffer | undefined;
    let camOriginal: Buffer | undefined;

    if (src.offsetSec > 0 && this.recorder) {
      const targetTime = timestamp - src.offsetSec * 1000;
      const ctxFrames = this.recorder.getContextFrames(src.cameraId, targetTime, 0, 1);
      if (ctxFrames.length > 0) {
        camOriginal = ctxFrames[0]!.data;
        camFrame = camOriginal;
      }
    }

    if (!camFrame) {
      camOriginal = this.frameProvider.getLatestFrame(src.cameraId);
      camFrame = camOriginal;
    }

    if (!camFrame) return;

    /** 先缩放 */
    const resized = await this.resizeToBuffer(camFrame, imageWidth);

    /** 再裁剪 ROI */
    let processed = resized;
    if (src.roiId > 0 && this.roiStorage) {
      processed = await this.cropToRoi(resized, src.roiId) ?? resized;
    }

    if (camOriginal && !cameraFrames.has(src.cameraId)) {
      cameraFrames.set(src.cameraId, { original: camOriginal, processed });
    }

    const camUrl = `data:image/jpeg;base64,${processed.toString("base64")}`;
    const offsetLabel = src.offsetSec > 0 ? ` (${src.offsetSec}s ago)` : "";
    userContent.push({ type: "text", text: `[Camera: ${src.cameraId}${offsetLabel}]` });
    userContent.push({ type: "image_url", image_url: { url: camUrl } });
  }
}
