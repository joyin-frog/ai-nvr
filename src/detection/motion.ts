import sharp from "sharp";
import { type EventBus } from "@/event-bus";
import { type RuntimeConfig } from "@/runtime-config";
import { type RoiStorage } from "@/storage/roi";

/** 每个摄像头的变动检测状态 */
interface CameraState {
  /** 上一帧的灰度像素数据 */
  prevPixels: Uint8Array | null;
  /** 上次触发变动事件的时间 */
  lastMotionTime: number;
  /** 是否正在处理中（防止帧堆积） */
  processing: boolean;
  /** 上次处理帧的时间戳（用于处理帧率节流） */
  lastProcessTime: number;
  /** ROI 缓存的 key（摄像头 ID + ROI 版本） */
  roiCacheKey: string;
  /** 预计算的 ROI mask（true = 在检测区域内） */
  roiMask: Uint8Array | null;
  /** 最近一次帧差异比率（0~1），供 AiDetector 判断是否跳过推理 */
  lastRatio: number;
}

/**
 * 变动检测器
 * 监听帧事件，通过灰度像素差异比对判断是否有变动
 * 支持 ROI（Region of Interest）：只在检测区域内计算像素差异
 */
export class MotionDetector {
  /** 每个摄像头的检测状态 */
  private states = new Map<string, CameraState>();
  /** ROI 多边形缓存（cameraId → 多边形列表），避免每次 processFrame 查 SQLite */
  private roiCache = new Map<string, { polygons: ReturnType<RoiStorage["getEnabledPolygons"]>; key: string }>();
  /** ROI 缓存失效时间（30 秒自动刷新） */
  private static readonly ROI_CACHE_TTL = 30_000;
  private roiCacheTime = 0;

  constructor(
    private runtimeConfig: RuntimeConfig,
    private eventBus: EventBus,
    private roiStorage: RoiStorage,
  ) {}

  /** 获取或创建摄像头状态 */
  private getOrCreateState(cameraId: string): CameraState {
    let state = this.states.get(cameraId);
    if (!state) {
      state = { prevPixels: null, lastMotionTime: 0, processing: false, lastProcessTime: 0, roiCacheKey: "", roiMask: null, lastRatio: 0 };
      this.states.set(cameraId, state);
    }
    return state;
  }

  /** 启动检测：监听检测帧事件 */
  start(): void {
    /** 双流模式下由 SD 检测流触发，单流模式下由共用流触发 */
    this.eventBus.on("detect:frame", (payload) => {
      this.processFrame(payload.cameraId, payload.data, payload.timestamp);
    });
  }

  /** 获取指定摄像头最近一次帧差异比率（0~1），供 AiDetector 判断是否跳过推理 */
  getLatestRatio(cameraId: string): number {
    return this.states.get(cameraId)?.lastRatio ?? 0;
  }

  /** 处理一帧 */
  private async processFrame(cameraId: string, jpeg: Buffer, timestamp: number): Promise<void> {
    const state = this.getOrCreateState(cameraId);

    /** 处理锁：上一帧还在处理中则跳过 */
    if (state.processing) return;

    /** 处理帧率节流：每 200ms 最多处理一次（5fps），无论输入帧率多高 */
    if (timestamp - state.lastProcessTime < 200) return;

    /** 快速校验：JPEG 必须以 FF D8 开头、FF D9 结尾 */
    if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[jpeg.length - 2] !== 0xff || jpeg[jpeg.length - 1] !== 0xd9) {
      return;
    }

    /** 在异步操作前立即标记 processing，防止并发 */
    state.processing = true;
    state.lastProcessTime = timestamp;

    /** 从 RuntimeConfig 获取该摄像头的有效配置（考虑覆盖） */
    const config = this.runtimeConfig.getMotionConfig(cameraId);

    /** 用 sharp 解码 JPEG → 灰度 → 缩放到比对分辨率 */
    let rawData: { data: Buffer; info: sharp.OutputInfo };
    try {
      rawData = await sharp(jpeg)
        .grayscale()
        .resize(config.compareWidth, config.compareHeight, { fit: "fill" })
        .raw()
        .toBuffer({ resolveWithObject: true });
    } catch {
      state.processing = false;
      return;
    }

    const { data, info } = rawData;
    const width = info.width;
    const height = info.height;
    const totalPixels = width * height;

    const pixels = new Uint8Array(data.buffer);

    try {
    /** 构建 ROI mask（使用缓存的多边形列表，仅在配置变化或 TTL 到期时重建） */
    const roiEntry = this.getCachedRoi(cameraId);
    const roiKey = `${width}x${height}:${roiEntry.key}`;
    if (state.roiCacheKey !== roiKey) {
      state.roiMask = this.buildRoiMaskFromPolygons(roiEntry.polygons, width, height);
      state.roiCacheKey = roiKey;
    }

    /** 第一帧，没有可对比的，存储后返回 */
    if (!state.prevPixels) {
      state.prevPixels = pixels;
      return;
    }

    /** 计算像素差异（考虑 ROI mask） */
    let diffCount = 0;
    let roiPixelCount = totalPixels;
    const prev = state.prevPixels;
    const mask = state.roiMask;

    if (mask) {
      roiPixelCount = 0;
      for (let i = 0; i < totalPixels; i++) {
        if (mask[i]) {
          roiPixelCount++;
          if (Math.abs(pixels[i]! - prev[i]!) > 25) {
            diffCount++;
          }
        }
      }
    } else {
      for (let i = 0; i < totalPixels; i++) {
        if (Math.abs(pixels[i]! - prev[i]!) > 25) {
          diffCount++;
        }
      }
    }

    /** ROI 内无像素则跳过 */
    if (roiPixelCount === 0) {
      state.prevPixels = pixels;
      return;
    }

    const ratio = diffCount / roiPixelCount;

    /** 保存最新 ratio 供 AiDetector 查询 */
    state.lastRatio = ratio;

    /** 更新上一帧 */
    state.prevPixels = pixels;

    /** 超过阈值且冷却期已过 → 触发变动事件 */
    if (ratio >= config.threshold && timestamp - state.lastMotionTime >= config.cooldown) {
      state.lastMotionTime = timestamp;
      this.eventBus.emit("motion", {
        cameraId,
        ratio,
        data: jpeg,
        timestamp,
      });
    }
    } finally {
      state.processing = false;
    }
  }

  /**
   * 获取缓存的 ROI 多边形列表（30 秒 TTL，避免每 200ms 查 SQLite）
   */
  private getCachedRoi(cameraId: string): { polygons: ReturnType<RoiStorage["getEnabledPolygons"]>; key: string } {
    const now = Date.now();
    if (now - this.roiCacheTime > MotionDetector.ROI_CACHE_TTL) {
      this.roiCache.clear();
      this.roiCacheTime = now;
    }
    let entry = this.roiCache.get(cameraId);
    if (!entry) {
      const polygons = this.roiStorage.getEnabledPolygons(cameraId);
      const key = polygons.length === 0
        ? "none"
        : polygons.map(p => p.points.map(pt => `${pt.x.toFixed(4)},${pt.y.toFixed(4)}`).join(";")).join("|");
      entry = { polygons, key };
      this.roiCache.set(cameraId, entry);
    }
    return entry;
  }

  /** ROI 缓存失效（外部调用，当 ROI 数据变更时） */
  invalidateRoiCache(): void {
    this.roiCache.clear();
    this.roiCacheTime = 0;
  }

  private buildRoiMaskFromPolygons(polygons: ReturnType<RoiStorage["getEnabledPolygons"]>, width: number, height: number): Uint8Array | null {
    if (polygons.length === 0) return null;

    const mask = new Uint8Array(width * height);

    for (const polygon of polygons) {
      if (polygon.points.length < 3) continue;
      this.rasterizePolygon(mask, polygon.points, width, height);
    }

    return mask;
  }

  /**
   * 将多边形光栅化到 mask 上（扫描线填充算法）
   * 坐标为归一化值 (0-1)，映射到图像像素坐标
   */
  private rasterizePolygon(
    mask: Uint8Array,
    points: Array<{ x: number; y: number }>,
    width: number,
    height: number,
  ): void {
    /** 转换为像素坐标 */
    const pixelPoints = points.map(p => ({
      x: Math.round(p.x * width),
      y: Math.round(p.y * height),
    }));

    /** 找到 Y 范围 */
    let minY = height;
    let maxY = 0;
    for (const p of pixelPoints) {
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    minY = Math.max(0, minY);
    maxY = Math.min(height - 1, maxY);

    /** 对每条扫描线，计算与多边形边的交点 */
    for (let y = minY; y <= maxY; y++) {
      const intersections: number[] = [];
      const n = pixelPoints.length;

      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const pi = pixelPoints[i]!;
        const pj = pixelPoints[j]!;

        if ((pi.y <= y && pj.y > y) || (pj.y <= y && pi.y > y)) {
          const x = pi.x + (y - pi.y) / (pj.y - pi.y) * (pj.x - pi.x);
          intersections.push(x);
        }
      }

      /** 排序交点，填充交点对之间的像素 */
      intersections.sort((a, b) => a - b);
      for (let k = 0; k < intersections.length - 1; k += 2) {
        const startX = Math.max(0, Math.ceil(intersections[k]!));
        const endX = Math.min(width - 1, Math.floor(intersections[k + 1]!));
        for (let x = startX; x <= endX; x++) {
          mask[y * width + x] = 1;
        }
      }
    }
  }
}
