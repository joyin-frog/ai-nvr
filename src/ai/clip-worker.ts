/**
 * CLIP Embedding Worker 线程
 * 使用 jina-clip-v2 模型提取图像/文本嵌入向量
 * 用于语义化目标识别、外观匹配（替代 dhash）、零样本分类
 */
import { parentPort, workerData } from "node:worker_threads";
import { AutoModel, AutoProcessor, RawImage, env as transformersEnv } from "@huggingface/transformers";
import sharp from "sharp";

const hfEndpoint = process.env.HF_ENDPOINT ?? "https://hf-mirror.com";
transformersEnv.remoteHost = `${hfEndpoint}/`;

interface ClipWorkerInit {
  model: string;
  cacheDir: string;
  /** 嵌入维度（Matryoshka 截断，默认 512） */
  embeddingDim: number;
}

/** 图像嵌入请求 */
interface ImageEmbedRequest {
  type: "image";
  id: number;
  /** JPEG/PNG 图像 buffer */
  image: Buffer;
  /** 可选裁剪区域（归一化 0-1） */
  crop?: { xmin: number; ymin: number; xmax: number; ymax: number };
}

/** 文本嵌入请求 */
interface TextEmbedRequest {
  type: "text";
  id: number;
  /** 文本数组 */
  texts: string[];
}

/** 零样本分类请求 */
interface ZeroShotRequest {
  type: "zero-shot";
  id: number;
  image: Buffer;
  crop?: { xmin: number; ymin: number; xmax: number; ymax: number };
  /** 候选标签 */
  labels: string[];
}

type ClipRequest = ImageEmbedRequest | TextEmbedRequest | ZeroShotRequest;

/** 嵌入结果 */
interface EmbedResult {
  id: number;
  type: string;
  /** 嵌入向量（Float32Array） */
  embeddings: number[][];
  /** 对应的标签（仅 zero-shot） */
  labels?: string[];
  /** 各标签的相似度分数（仅 zero-shot） */
  scores?: number[];
  inferMs: number;
  error?: string;
}

const init = workerData as ClipWorkerInit;
transformersEnv.cacheDir = init.cacheDir;

let model: Awaited<ReturnType<typeof AutoModel.from_pretrained>> | null = null;
let processor: Awaited<ReturnType<typeof AutoProcessor.from_pretrained>> | null = null;

/** 待处理请求队列 */
let pending: ClipRequest | null = null;
/** 推理中 */
let busy = false;

/** 加载模型 */
async function loadModel(): Promise<void> {
  console.log(`[CLIP Worker] 加载模型: ${init.model}`);
  processor = await AutoProcessor.from_pretrained(init.model);
  model = await AutoModel.from_pretrained(init.model, {
    dtype: "q4",
  });
  console.log(`[CLIP Worker] 模型加载完成 (dim=${init.embeddingDim})`);
  parentPort?.postMessage({ type: "ready" });
}

/** 从 JPEG/PNG buffer 创建 RawImage（支持可选裁剪） */
async function prepareImage(
  imageBuf: Buffer,
  crop?: { xmin: number; ymin: number; xmax: number; ymax: number },
): Promise<RawImage> {
  let img = sharp(imageBuf);
  const meta = await img.metadata();
  const w = meta.width ?? 1;
  const h = meta.height ?? 1;

  if (crop) {
    const left = Math.round(crop.xmin * w);
    const top = Math.round(crop.ymin * h);
    const right = Math.round(crop.xmax * w);
    const bottom = Math.round(crop.ymax * h);
    const cropW = Math.max(1, right - left);
    const cropH = Math.max(1, bottom - top);
    img = img.extract({ left, top, width: cropW, height: cropH });
  }

  const raw = await img.removeAlpha().raw().toBuffer();
  const newMeta = await img.metadata();
  return new RawImage(raw, newMeta.width ?? 1, newMeta.height ?? 1, 3);
}

/** 截断嵌入维度（Matryoshka） */
function truncateEmbedding(embedding: number[], dim: number): number[] {
  if (dim >= embedding.length) return embedding;
  return embedding.slice(0, dim);
}

/** 提取图像嵌入 */
async function imageEmbed(req: ImageEmbedRequest): Promise<EmbedResult> {
  const start = performance.now();
  const rawImage = await prepareImage(req.image, req.crop);
  const inputs = await processor!(null, [rawImage], { padding: true, truncation: true });
  const output = await model!(inputs);
  const imageData = output.l2norm_image_embeddings.data as Float32Array;
  const dim = output.l2norm_image_embeddings.dims.at(-1) ?? 1024;

  /** 提取第一行（batch size = 1） */
  const fullEmbed = Array.from(imageData.slice(0, dim));
  const truncated = truncateEmbedding(fullEmbed, init.embeddingDim);

  return {
    id: req.id,
    type: "image",
    embeddings: [truncated],
    inferMs: performance.now() - start,
  };
}

/** 提取文本嵌入 */
async function textEmbed(req: TextEmbedRequest): Promise<EmbedResult> {
  const start = performance.now();
  const inputs = await processor!(req.texts, null, { padding: true, truncation: true });
  const output = await model!(inputs);
  const textData = output.l2norm_text_embeddings.data as Float32Array;
  const dim = output.l2norm_text_embeddings.dims.at(-1) ?? 1024;
  const batchSize = output.l2norm_text_embeddings.dims[0] ?? req.texts.length;

  const embeddings: number[][] = [];
  for (let i = 0; i < batchSize; i++) {
    const fullEmbed = Array.from(textData.slice(i * dim, (i + 1) * dim));
    embeddings.push(truncateEmbedding(fullEmbed, init.embeddingDim));
  }

  return {
    id: req.id,
    type: "text",
    embeddings,
    inferMs: performance.now() - start,
  };
}

/** 零样本分类 */
async function zeroShot(req: ZeroShotRequest): Promise<EmbedResult> {
  const start = performance.now();
  const rawImage = await prepareImage(req.image, req.crop);
  const inputs = await processor!(req.labels, [rawImage], { padding: true, truncation: true });
  const output = await model!(inputs);

  const imageData = output.l2norm_image_embeddings.data as Float32Array;
  const textData = output.l2norm_text_embeddings.data as Float32Array;
  const dim = output.l2norm_image_embeddings.dims.at(-1) ?? 1024;
  const textBatchSize = output.l2norm_text_embeddings.dims[0] ?? req.labels.length;

  /** 余弦相似度 = 点积（因为已 L2 归一化） */
  const imageEmbed = imageData.slice(0, dim);
  const scores: number[] = [];
  for (let i = 0; i < textBatchSize; i++) {
    let dot = 0;
    for (let j = 0; j < dim; j++) {
      dot += imageEmbed[j]! * textData[i * dim + j]!;
    }
    scores.push(dot);
  }

  return {
    id: req.id,
    type: "zero-shot",
    embeddings: [Array.from(imageEmbed.slice(0, init.embeddingDim))],
    labels: req.labels,
    scores,
    inferMs: performance.now() - start,
  };
}

/** 处理请求 */
async function processRequest(req: ClipRequest): Promise<void> {
  if (!model || !processor) return;
  busy = true;

  let result: EmbedResult;
  if (req.type === "image") {
    result = await imageEmbed(req);
  } else if (req.type === "text") {
    result = await textEmbed(req);
  } else {
    result = await zeroShot(req);
  }

  parentPort?.postMessage({ type: "result", id: result.id, resultType: result.type, embeddings: result.embeddings, labels: result.labels, scores: result.scores, inferMs: result.inferMs, error: result.error });
  busy = false;

  /** 检查队列 */
  if (pending) {
    const next = pending;
    pending = null;
    processRequest(next);
  }
}

parentPort?.on("message", (req: ClipRequest) => {
  if (busy) {
    /** 新请求覆盖旧的（只保留最新） */
    pending = req;
    return;
  }
  processRequest(req);
});

loadModel().catch((err) => {
  console.error(`[CLIP Worker] 模型加载失败:`, err);
  parentPort?.postMessage({ type: "error", error: String(err) });
});
