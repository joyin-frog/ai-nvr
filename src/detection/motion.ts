import sharp from "sharp";
import { type MotionConfig } from "@/config";
import { type EventBus } from "@/event-bus";

/** 每个摄像头的变动检测状态 */
interface CameraState {
  /** 上一帧的灰度像素数据 */
  prevPixels: Uint8Array | null;
  /** 上次触发变动事件的时间 */
  lastMotionTime: number;
}

/**
 * 变动检测器
 * 监听帧事件，通过灰度像素差异比对判断是否有变动
 */
export class MotionDetector {
  /** 每个摄像头的检测状态 */
  private states = new Map<string, CameraState>();

  constructor(
    private config: MotionConfig,
    private eventBus: EventBus,
  ) {}

  /** 启动检测：监听帧事件 */
  start(): void {
    this.eventBus.on("frame", (payload) => {
      this.processFrame(payload.cameraId, payload.data, payload.timestamp);
    });
  }

  /** 处理一帧 */
  private async processFrame(cameraId: string, jpeg: Buffer, timestamp: number): Promise<void> {
    /** 快速校验：JPEG 必须以 FF D8 开头、FF D9 结尾 */
    if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[jpeg.length - 2] !== 0xff || jpeg[jpeg.length - 1] !== 0xd9) {
      return;
    }

    /** 用 sharp 解码 JPEG → 灰度 → 缩放到比对分辨率 */
    let rawData: { data: Buffer; info: sharp.OutputInfo };
    try {
      rawData = await sharp(jpeg)
        .grayscale()
        .resize(this.config.compareWidth, this.config.compareHeight, { fit: "fill" })
        .raw()
        .toBuffer({ resolveWithObject: true });
    } catch {
      /** 解码失败的帧直接跳过 */
      return;
    }

    const { data, info } = rawData;

    const pixels = new Uint8Array(data.buffer);
    let state = this.states.get(cameraId);

    if (!state) {
      state = { prevPixels: null, lastMotionTime: 0 };
      this.states.set(cameraId, state);
    }

    /** 第一帧，没有可对比的，存储后返回 */
    if (!state.prevPixels) {
      state.prevPixels = pixels;
      return;
    }

    /** 计算像素差异 */
    const totalPixels = info.width * info.height;
    let diffCount = 0;
    const prev = state.prevPixels;

    for (let i = 0; i < totalPixels; i++) {
      /** 灰度图每像素 1 字节，绝对差值 > 25 算变动 */
      if (Math.abs(pixels[i]! - prev[i]!) > 25) {
        diffCount++;
      }
    }

    const ratio = diffCount / totalPixels;

    /** 更新上一帧 */
    state.prevPixels = pixels;

    /** 超过阈值且冷却期已过 → 触发变动事件 */
    if (ratio >= this.config.threshold && timestamp - state.lastMotionTime >= this.config.cooldown) {
      state.lastMotionTime = timestamp;
      this.eventBus.emit("motion", {
        cameraId,
        ratio,
        data: jpeg,
        timestamp,
      });
    }
  }
}
