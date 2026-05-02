import sharp from "sharp";
import { type Detection } from "./types";

/** 检测框颜色映射（COCO 常见类别） */
const LABEL_COLORS: Record<string, string> = {
  person: "#FF6B6B",
  car: "#4ECDC4",
  truck: "#45B7D1",
  bus: "#96CEB4",
  bicycle: "#FFEAA7",
  motorcycle: "#DDA0DD",
  dog: "#98D8C8",
  cat: "#F7DC6F",
  bird: "#BB8FCE",
  "cell phone": "#85C1E9",
  laptop: "#F0B27A",
};

/** 默认颜色 */
const DEFAULT_COLOR = "#FF4444";

/**
 * 图片标注器
 * 在 JPEG 图片上画检测框 + 标签文字
 * 标注图按需生成（API 请求时才生成），不再随每帧检测自动生成
 */
export class Annotator {
  /** 缓存的图片尺寸（按摄像头 ID） */
  private cachedDimensions = new Map<string, { width: number; height: number }>();
  /** 缓存的最新帧（用于按需生成标注图） */
  private latestFrames = new Map<string, { jpeg: Buffer; detections: Detection[] }>();

  /** 缓存最新帧和检测结果 */
  setLatestFrame(cameraId: string, jpeg: Buffer, detections: Detection[]): void {
    this.latestFrames.set(cameraId, { jpeg, detections });
  }

  /** 获取最近标注后的图片（按需生成） */
  getLatest(cameraId: string): Buffer | undefined {
    const cached = this.latestFrames.get(cameraId);
    if (!cached || cached.detections.length === 0) return cached?.jpeg;
    /** 同步返回 undefined，标注图通过 generateAnnotated 获取 */
    return undefined;
  }

  /** 按需生成标注图 */
  async generateAnnotated(cameraId: string): Promise<Buffer | undefined> {
    const cached = this.latestFrames.get(cameraId);
    if (!cached) return undefined;
    if (cached.detections.length === 0) return cached.jpeg;
    return this.annotate(cached.jpeg, cached.detections, cameraId);
  }

  /** 在图片上画检测框和标签 */
  async annotate(jpeg: Buffer, detections: Detection[], cameraId?: string): Promise<Buffer> {
    if (detections.length === 0) return jpeg;

    /** 获取图片尺寸（优先使用缓存） */
    let dims = cameraId ? this.cachedDimensions.get(cameraId) : undefined;
    if (!dims) {
      const metadata = await sharp(jpeg).metadata();
      dims = { width: metadata.width ?? 640, height: metadata.height ?? 360 };
      if (cameraId) this.cachedDimensions.set(cameraId, dims);
    }
    const { width, height } = dims;

    /** 构建 SVG 叠加层 */
    const svgElements: string[] = [];

    for (const det of detections) {
      const { xmin, ymin, xmax, ymax } = det.box;
      /** 优先使用主色调，然后按类别颜色，最后默认色 */
      const color = det.dominantColor ?? LABEL_COLORS[det.label] ?? DEFAULT_COLOR;
      /** 归一化坐标 (0-1) 转为像素坐标 */
      const px = xmin * width;
      const py = ymin * height;
      const pw = (xmax - xmin) * width;
      const ph = (ymax - ymin) * height;

      /** 检测框：有自定义名称的用实线粗框，否则虚线 */
      const strokeDash = det.trackName ? "" : ' stroke-dasharray="6 3"';
      const strokeWidth = det.trackName ? 4 : 2;
      svgElements.push(
        `<rect x="${px}" y="${py}" width="${pw}" height="${ph}" fill="none" stroke="${color}" stroke-width="${strokeWidth}"${strokeDash}/>`,
      );

      /** 标签：优先显示自定义名称，否则显示 #trackId label */
      const trackPrefix = det.trackId != null ? `#${det.trackId} ` : "";
      const labelText = det.trackName
        ? `${det.trackName} ${(det.score * 100).toFixed(0)}%`
        : `${trackPrefix}${det.label} ${(det.score * 100).toFixed(0)}%`;
      const fontSize = Math.max(14, Math.min(width, height) / 30);
      /** 估算文字宽度：中文等宽字符约 1.0em，ASCII 约 0.6em */
      let charWidthSum = 0;
      for (const ch of labelText) {
        charWidthSum += ch.charCodeAt(0) > 0x7f ? 1.0 : 0.6;
      }
      const textWidth = charWidthSum * fontSize + 8;
      const textHeight = fontSize + 6;
      /** 标签在框上方，如果太靠近顶部则放到框内下方 */
      const labelY = py > textHeight + 2 ? py - textHeight : py + ph;

      svgElements.push(
        `<rect x="${px}" y="${labelY}" width="${textWidth}" height="${textHeight}" fill="${color}" opacity="0.85"/>`,
      );
      svgElements.push(
        `<text x="${px + 4}" y="${labelY + fontSize + 1}" fill="white" font-size="${fontSize}" font-family="sans-serif" font-weight="bold">${labelText}</text>`,
      );
    }

    const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${svgElements.join("")}</svg>`;

    /** 用 sharp 合成：原图 + SVG 叠加 */
    return sharp(jpeg)
      .composite([{ input: Buffer.from(svg), gravity: "northwest" }])
      .jpeg({ quality: 85 })
      .toBuffer();
  }
}
