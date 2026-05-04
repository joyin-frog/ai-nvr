import sharp from "sharp";

/**
 * 将图片 Buffer 缩放为 JPEG data URL
 * @param img 原始图片 Buffer
 * @param imageWidth 目标宽度（0 表示不缩放）
 * @param quality JPEG 质量（默认 80）
 */
export async function resizeToDataUrl(img: Buffer, imageWidth: number, quality = 80): Promise<string> {
  if (imageWidth > 0) {
    const resized = await sharp(img, { failOn: "none" })
      .resize(imageWidth)
      .jpeg({ quality })
      .toBuffer();
    return `data:image/jpeg;base64,${resized.toString("base64")}`;
  }
  return `data:image/jpeg;base64,${img.toString("base64")}`;
}

/**
 * 将图片 Buffer 缩放为 Buffer（用于后续处理如 ROI 裁剪）
 * @param img 原始图片 Buffer
 * @param imageWidth 目标宽度（0 表示不缩放）
 */
export async function resizeToBuffer(img: Buffer, imageWidth: number): Promise<Buffer> {
  if (imageWidth > 0) {
    return sharp(img, { failOn: "none" })
      .resize(imageWidth)
      .jpeg({ quality: 80 })
      .toBuffer();
  }
  return img;
}
