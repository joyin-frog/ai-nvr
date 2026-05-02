/**
 * AI 检测 Worker 线程
 * 使用 jina-clip-v2 零样本分类替代 YOLO 目标检测
 * 对全图做语义化识别，输出场景级标签和图像嵌入
 */
import { parentPort, workerData } from "node:worker_threads";
import { AutoModel, AutoProcessor, RawImage, env as transformersEnv } from "@huggingface/transformers";
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
  /** 候选标签列表 */
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
  /** 图像嵌入向量（用于外观匹配） */
  embedding: number[];
  fingerprint: string;
  inferMs: number;
  resizeMs: number;
  error?: string;
}

let model: Awaited<ReturnType<typeof AutoModel.from_pretrained>> | null = null;
let processor: Awaited<ReturnType<typeof AutoProcessor.from_pretrained>> | null = null;

const init = workerData as WorkerInit;

let currentRequestId = 0;
let pendingReq: DetectRequest | null = null;
let busy = false;

/** 默认候选标签 */
const DEFAULT_LABELS = [
  "a person",
  "a car",
  "a truck",
  "a bus",
  "a motorcycle",
  "a bicycle",
  "a dog",
  "multiple dogs",
  "a cat",
  "empty scene",
];

/** 文本嵌入缓存 */
let cachedLabels: string[] = [];
let cachedTextEmbeddings: Float32Array | null = null;

/** 加载模型 */
async function loadModel(): Promise<void> {
  console.log(`[CLIP Worker] 加载模型: ${init.model}`);
  processor = await AutoProcessor.from_pretrained(init.model);
  model = await AutoModel.from_pretrained(init.model, {
    dtype: "int8",
  });
  console.log(`[CLIP Worker] 模型加载完成`);
  parentPort?.postMessage({ type: "ready" });
}

/** 预计算文本嵌入（标签变化时重新计算） */
async function ensureTextEmbeddings(labels: string[]): Promise<void> {
  if (!model || !processor) return;
  if (cachedLabels.length === labels.length && cachedLabels.every((l, i) => l === labels[i]) && cachedTextEmbeddings) {
    return;
  }
  cachedLabels = labels;
  const inputs = await processor(labels, null, { padding: true, truncation: true });
  const output = await model(inputs);
  const textData = output.l2norm_text_embeddings.data as Float32Array;
  const dim = output.l2norm_text_embeddings.dims.at(-1) ?? 1024;
  const batchSize = output.l2norm_text_embeddings.dims[0] ?? labels.length;

  cachedTextEmbeddings = new Float32Array(batchSize * dim);
  for (let i = 0; i < batchSize; i++) {
    for (let j = 0; j < dim; j++) {
      cachedTextEmbeddings[i * dim + j] = textData[i * dim + j]!;
    }
  }
}

/** 执行零样本分类推理 */
async function detect(req: DetectRequest): Promise<void> {
  if (!model || !processor) return;

  currentRequestId = req.id;
  const labels = req.labels.length > 0 ? req.labels : DEFAULT_LABELS;

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

    /** 图像推理 */
    const inputs = await processor(null, [rawImage], { padding: true, truncation: true });
    const t1 = performance.now();
    const output = await model(inputs);
    result.inferMs = performance.now() - t1;

    /** 提取图像嵌入 */
    const imageData = output.l2norm_image_embeddings.data as Float32Array;
    const dim = output.l2norm_image_embeddings.dims.at(-1) ?? 1024;
    const imageEmbed = imageData.slice(0, dim);
    result.embedding = Array.from(imageEmbed);

    /** 预计算文本嵌入 */
    await ensureTextEmbeddings(labels);
    if (!cachedTextEmbeddings) return;

    /** 计算每个标签的相似度（余弦相似度 = 点积，因为已 L2 归一化） */
    const scores: Array<{ label: string; score: number }> = [];
    for (let l = 0; l < labels.length; l++) {
      let dot = 0;
      for (let j = 0; j < dim; j++) {
        dot += imageEmbed[j]! * cachedTextEmbeddings[l * dim + j]!;
      }
      scores.push({ label: labels[l]!, score: dot });
    }

    /** 过滤 "empty" 类标签，只保留有意义的目标标签 */
    const emptyLabels = new Set(["empty scene", "empty background", "no objects", "nothing"]);
    const filtered = scores
      .filter(s => !emptyLabels.has(s.label) && s.score >= req.threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, req.maxDetections);

    /** 全图检测结果（框覆盖整图，因为 CLIP 不做空间定位）
     *  标签转换：去掉 "a " 前缀（"a dog" → "dog"），保持原样 "multiple dogs"
     */
    result.detections = filtered.map(s => ({
      label: s.label.startsWith("a ") ? s.label.slice(2) : s.label,
      score: Math.min(s.score, 1),
      box: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 },
    }));

    /** 指纹 */
    result.fingerprint = result.detections.length === 0 ? ""
      : result.detections.map(d => `${d.label}:${d.score.toFixed(2)}`).sort().join("|");
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
  console.error(`[CLIP Worker] 模型加载失败:`, err);
  parentPort?.postMessage({ type: "error", error: String(err) });
});
