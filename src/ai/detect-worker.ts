/**
 * AI 检测 Worker 线程
 * 支持 YOLO/DETR 目标检测模型（带空间定位检测框）
 * 使用 transformers.js pipeline("object-detection") 推理
 */
import { parentPort, workerData } from "node:worker_threads";
import { pipeline, env as transformersEnv, RawImage } from "@huggingface/transformers";
import sharp from "sharp";

/** 设置模型下载源 */
const hfEndpoint = process.env.HF_ENDPOINT ?? "https://hf-mirror.com";
transformersEnv.remoteHost = `${hfEndpoint}/`;
transformersEnv.cacheDir = (workerData as { cacheDir: string }).cacheDir;

/** Worker 启动参数 */
interface WorkerInit {
  model: string;
  cacheDir: string;
}

/** 推理请求 */
interface DetectRequest {
  id: number;
  cameraId: string;
  jpeg: Buffer;
  timestamp: number;
  inputWidth: number;
  threshold: number;
  maxDetections: number;
  /** 候选标签列表（用于过滤，YOLO 使用 COCO 80 类不需要） */
  labels: string[];
}

/** 推理响应 */
interface DetectResult {
  id: number;
  cameraId: string;
  timestamp: number;
  detections: Array<{
    label: string;
    score: number;
    box: { xmin: number; ymin: number; xmax: number; ymax: number };
  }>;
  /** 图像嵌入向量（CLIP，可选） */
  embedding: number[];
  fingerprint: string;
  inferMs: number;
  resizeMs: number;
  error?: string;
}

/** 检测器实例 */
let detector: Awaited<ReturnType<typeof pipeline>> | null = null;

const init = workerData as WorkerInit;

let currentRequestId = 0;
let pendingReq: DetectRequest | null = null;
let busy = false;

/** NMS（非极大值抑制） */
function nms(
  detections: Array<{ label: string; score: number; box: { xmin: number; ymin: number; xmax: number; ymax: number } }>,
  iouThreshold: number,
): Array<{ label: string; score: number; box: { xmin: number; ymin: number; xmax: number; ymax: number } }> {
  const sorted = [...detections].sort((a, b) => b.score - a.score);
  const kept: typeof detections = [];
  const suppressed = new Set<number>();

  for (let i = 0; i < sorted.length; i++) {
    if (suppressed.has(i)) continue;
    kept.push(sorted[i]!);
    for (let j = i + 1; j < sorted.length; j++) {
      if (suppressed.has(j)) continue;
      const iou = computeIoU(sorted[i]!.box, sorted[j]!.box);
      if (iou > iouThreshold) {
        suppressed.add(j);
      }
    }
  }
  return kept;
}

function computeIoU(
  a: { xmin: number; ymin: number; xmax: number; ymax: number },
  b: { xmin: number; ymin: number; xmax: number; ymax: number },
): number {
  const x1 = Math.max(a.xmin, b.xmin);
  const y1 = Math.max(a.ymin, b.ymin);
  const x2 = Math.min(a.xmax, b.xmax);
  const y2 = Math.min(a.ymax, b.ymax);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = (a.xmax - a.xmin) * (a.ymax - a.ymin);
  const areaB = (b.xmax - b.xmin) * (b.ymax - b.ymin);
  return inter / (areaA + areaB - inter + 1e-6);
}

/** 加载模型 */
async function loadModel(): Promise<void> {
  console.log(`[Detect Worker] 加载模型: ${init.model}`);
  detector = await pipeline("object-detection", init.model, {
    dtype: "fp32",
  });
  console.log(`[Detect Worker] 模型加载完成`);
  parentPort?.postMessage({ type: "ready" });
}

/** 执行目标检测推理 */
async function detect(req: DetectRequest): Promise<void> {
  if (!detector) return;

  currentRequestId = req.id;

  const result: DetectResult = {
    id: req.id,
    cameraId: req.cameraId,
    timestamp: req.timestamp,
    detections: [],
    embedding: [],
    fingerprint: "",
    inferMs: 0,
    resizeMs: 0,
  };

  try {
    const t0 = performance.now();

    /** 缩放 + 转为 RawImage */
    const inferW = req.inputWidth > 0 ? req.inputWidth : 640;
    const { data, info } = await sharp(req.jpeg)
      .resize(inferW)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    result.resizeMs = performance.now() - t0;

    const rawImage = new RawImage(new Uint8ClampedArray(data), info.width, info.height, info.channels);

    /** 推理 */
    const t1 = performance.now();
    const raw = await (detector as Function)(rawImage, {
      threshold: req.threshold,
      percentage: true,
    });
    result.inferMs = performance.now() - t1;

    /** NMS 去重（pipeline 可能输出大量重叠框） */
    const afterNms = nms(raw as DetectResult["detections"], 0.45);

    /** 标签过滤 + 限制数量 */
    const labelSet = req.labels.length > 0 ? new Set(req.labels) : null;
    const filtered = afterNms
      .filter(d => !labelSet || labelSet.has(d.label))
      .slice(0, req.maxDetections);

    result.detections = filtered;

    /** 指纹 */
    result.fingerprint = filtered.length === 0 ? ""
      : filtered.map(d => `${d.label}:${d.score.toFixed(2)}`).sort().join("|");
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }

  if (currentRequestId === req.id) {
    parentPort?.postMessage({ type: "result", data: result });
  }
}

async function drainPending(): Promise<void> {
  while (pendingReq) {
    const req = pendingReq;
    pendingReq = null;
    await detect(req);
  }
  busy = false;
}

parentPort?.on("message", (msg: { type: string; data?: DetectRequest }) => {
  if (msg.type === "detect" && msg.data) {
    if (busy) {
      pendingReq = msg.data;
    } else {
      busy = true;
      detect(msg.data).then(() => drainPending());
    }
  }
});

loadModel().catch((err) => {
  console.error(`[Detect Worker] 模型加载失败:`, err);
  parentPort?.postMessage({ type: "error", error: String(err) });
});
