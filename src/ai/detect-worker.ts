/**
 * AI 检测 Worker 线程
 * 在独立线程中运行 ONNX 模型推理，避免阻塞主线程 HTTP 服务
 */
import { parentPort, workerData } from "node:worker_threads";
import { pipeline, env as transformersEnv, type ObjectDetectionPipeline, RawImage } from "@huggingface/transformers";
import sharp from "sharp";

/** 设置模型下载源 */
const hfEndpoint = process.env.HF_ENDPOINT ?? "https://hf-mirror.com";
transformersEnv.remoteHost = `${hfEndpoint}/`;

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
  fingerprint: string;
  inferMs: number;
  resizeMs: number;
  error?: string;
}

let detector: ObjectDetectionPipeline | null = null;
const init = workerData as WorkerInit;

transformersEnv.cacheDir = init.cacheDir;

/** 当前正在推理的请求 ID（推理锁） */
let currentRequestId = 0;

/** 最新待处理的请求（新请求覆盖旧的，实现自动跳帧） */
let pendingReq: DetectRequest | null = null;
/** 推理进行中 */
let busy = false;

/** 加载模型 */
async function loadModel(): Promise<void> {
  console.log(`[AI Worker] 加载模型: ${init.model}`);
  detector = await pipeline("object-detection", init.model, {
    device: "cpu",
  });
  console.log(`[AI Worker] 模型加载完成`);
  parentPort?.postMessage({ type: "ready" });
}

/** 执行推理 */
async function detect(req: DetectRequest): Promise<void> {
  if (!detector) return;

  currentRequestId = req.id;

  const result: DetectResult = {
    id: req.id,
    cameraId: req.cameraId,
    timestamp: req.timestamp,
    detections: [],
    fingerprint: "",
    inferMs: 0,
    resizeMs: 0,
  };

  try {
    /** 缩放 + 转为 RawImage（跳过 JPEG 重编码，直接输出 RGB 像素） */
    let inferenceInput: RawImage | Blob;
    const t1 = performance.now();
    if (req.inputWidth > 0) {
      const { data, info } = await sharp(req.jpeg)
        .resize(req.inputWidth)
        .raw()
        .toBuffer({ resolveWithObject: true });
      result.resizeMs = performance.now() - t1;
      inferenceInput = new RawImage(new Uint8ClampedArray(data), info.width, info.height, info.channels);
    } else {
      result.resizeMs = performance.now() - t1;
      inferenceInput = new Blob([req.jpeg]);
    }

    /** 推理 */
    const t2 = performance.now();
    const raw = await detector(inferenceInput, {
      threshold: req.threshold,
      percentage: true,
    });
    result.inferMs = performance.now() - t2;

    /** 解析结果 */
    result.detections = (raw as Array<{
      score: number;
      label: string;
      box: { xmin: number; ymin: number; xmax: number; ymax: number };
    }>)
      .slice(0, req.maxDetections)
      .map(item => ({
        label: item.label,
        score: item.score,
        box: item.box,
      }));

    /** 计算指纹 */
    result.fingerprint = result.detections.length === 0 ? ""
      : result.detections
        .map(d => `${d.label}:${Math.round(d.box.xmin * 20)},${Math.round(d.box.ymin * 20)},${Math.round(d.box.xmax * 20)},${Math.round(d.box.ymax * 20)}`)
        .sort()
        .join("|");
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }

  /** 只有当前请求才返回结果（跳过被覆盖的旧请求） */
  if (currentRequestId === req.id) {
    parentPort?.postMessage({ type: "result", data: result });
  }
}

/** 处理下一个待处理请求 */
async function drainPending(): Promise<void> {
  while (pendingReq) {
    const req = pendingReq;
    pendingReq = null;
    await detect(req);
  }
  busy = false;
}

/** 监听主线程消息 */
parentPort?.on("message", (msg: { type: string; data?: DetectRequest }) => {
  if (msg.type === "detect" && msg.data) {
    if (busy) {
      /** 推理进行中 → 覆盖旧待处理请求（自动跳帧） */
      pendingReq = msg.data;
    } else {
      busy = true;
      detect(msg.data).then(() => drainPending());
    }
  }
});

loadModel().catch((err) => {
  console.error(`[AI Worker] 模型加载失败:`, err);
  parentPort?.postMessage({ type: "error", error: String(err) });
});
