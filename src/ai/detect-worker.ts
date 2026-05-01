/**
 * AI 检测 Worker 线程
 * 在独立线程中运行 ONNX 模型推理，避免阻塞主线程 HTTP 服务
 */
import { parentPort, workerData } from "node:worker_threads";
import { pipeline, env as transformersEnv, type ObjectDetectionPipeline } from "@huggingface/transformers";
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
    /** 缩放 */
    let inferenceInput: Blob;
    const t1 = performance.now();
    if (req.inputWidth > 0) {
      const resized = await sharp(req.jpeg)
        .resize(req.inputWidth)
        .jpeg({ quality: 85 })
        .toBuffer();
      result.resizeMs = performance.now() - t1;
      inferenceInput = new Blob([resized]);
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

  parentPort?.postMessage({ type: "result", data: result });
}

/** 监听主线程消息 */
parentPort?.on("message", (msg: { type: string; data?: DetectRequest }) => {
  if (msg.type === "detect" && msg.data) {
    detect(msg.data);
  }
});

loadModel().catch((err) => {
  console.error(`[AI Worker] 模型加载失败:`, err);
  parentPort?.postMessage({ type: "error", error: String(err) });
});
