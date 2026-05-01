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
 */
export class Annotator {
  /** 最近一次标注后的图片（按摄像头 ID 存储） */
  private latestAnnotated = new Map<string, Buffer>();

  /** 保存标注后的图片 */
  setLatest(cameraId: string, image: Buffer): void {
    this.latestAnnotated.set(cameraId, image);
  }

  /** 获取最近标注后的图片 */
  getLatest(cameraId: string): Buffer | undefined {
    return this.latestAnnotated.get(cameraId);
  }

  /** 在图片上画检测框和标签 */
  async annotate(jpeg: Buffer, detections: Detection[]): Promise<Buffer> {
    if (detections.length === 0) return jpeg;

    /** 获取图片尺寸 */
    const metadata = await sharp(jpeg).metadata();
    const width = metadata.width ?? 640;
    const height = metadata.height ?? 360;

    /** 构建 SVG 叠加层 */
    const svgElements: string[] = [];

    for (const det of detections) {
      const { xmin, ymin, xmax, ymax } = det.box;
      const color = LABEL_COLORS[det.label] ?? DEFAULT_COLOR;
      /** 归一化坐标 (0-1) 转为像素坐标 */
      const px = xmin * width;
      const py = ymin * height;
      const pw = (xmax - xmin) * width;
      const ph = (ymax - ymin) * height;

      /** 检测框 */
      svgElements.push(
        `<rect x="${px}" y="${py}" width="${pw}" height="${ph}" fill="none" stroke="${color}" stroke-width="3"/>`,
      );

      /** 标签背景 + 文字 */
      const trackPrefix = "trackId" in det ? `#${(det as { trackId: number }).trackId} ` : "";
      const labelText = `${trackPrefix}${det.label} ${(det.score * 100).toFixed(0)}%`;
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
