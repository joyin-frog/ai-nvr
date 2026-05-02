/**
 * CLIP Service — 管理零样本分类 Worker
 * 对 YOLO 检测到的目标裁剪区域执行零样本语义分类，
 * 提供比 YOLO label 更丰富的描述（如 "black dog", "small white car"）
 */
import { Worker } from "node:worker_threads";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureModelCached } from "./model-downloader";

/** CLIP Service 配置 */
export interface ClipConfig {
  /** 是否启用 */
  enabled: boolean;
  /** 模型名称（Hugging Face Hub） */
  model: string;
  /** 嵌入维度（Matryoshka 截断，默认 512） */
  embeddingDim: number;
}

/** 零样本分类结果 */
export interface ZeroShotResult {
  /** 候选标签 */
  labels: string[];
  /** 各标签的相似度分数 */
  scores: number[];
  /** 推理耗时 ms */
  inferMs: number;
}

/** 图像嵌入结果 */
export interface ImageEmbedResult {
  /** 嵌入向量（Float32，已 L2 归一化） */
  embedding: number[];
  /** 推理耗时 ms */
  inferMs: number;
}

/** Worker 初始化参数 */
interface ClipWorkerInit {
  model: string;
  cacheDir: string;
  embeddingDim: number;
}

/** 分类请求 */
interface ClassifyRequest {
  type: "zero-shot";
  id: number;
  image: Buffer;
  crop?: { xmin: number; ymin: number; xmax: number; ymax: number };
  labels: string[];
}

/** 图像嵌入请求 */
interface EmbedRequest {
  type: "image";
  id: number;
  image: Buffer;
  crop?: { xmin: number; ymin: number; xmax: number; ymax: number };
}

/** Worker 响应 */
interface ClipWorkerResponse {
  type: "result" | "ready" | "error";
  id?: number;
  resultType?: string;
  embeddings?: number[][];
  labels?: string[];
  scores?: number[];
  inferMs?: number;
  error?: string;
}

/** 请求 ID 计数器 */
let requestId = 0;

/** 零样本分类待处理请求 */
const pendingClassify = new Map<number, {
  resolve: (result: ZeroShotResult) => void;
  reject: (err: Error) => void;
}>();

/** 图像嵌入待处理请求 */
const pendingEmbed = new Map<number, {
  resolve: (result: ImageEmbedResult) => void;
  reject: (err: Error) => void;
}>();

/**
 * 每个基础标签的细分候选标签
 * 用于零样本分类：根据 YOLO 的基础 label 选择对应的候选列表
 */
const CANDIDATE_LABELS: Record<string, string[]> = {
  person: [
    "a person standing still",
    "a person walking",
    "a person running",
    "a person carrying something",
    "a person wearing dark clothes",
    "a person wearing bright clothes",
    "a person wearing red",
    "a person wearing blue",
    "a person wearing white",
    "a person with a hat",
    "a person with a backpack",
    "a person holding a phone",
    "a person pushing a stroller",
    "a person on crutches",
    "a child",
    "an elderly person",
    "a tall person",
    "a short person",
    "a person wearing a mask",
    "a person wearing glasses",
  ],
  dog: [
    "a black dog",
    "a white dog",
    "a brown dog",
    "a golden retriever",
    "a small dog",
    "a large dog",
    "a dog sitting",
    "a dog running",
    "a dog lying down",
    "a dog with a collar",
    "a dog on a leash",
    "a dog barking",
    "multiple dogs together",
  ],
  cat: [
    "a black cat",
    "a white cat",
    "an orange cat",
    "a striped cat",
    "a small cat",
    "a fluffy cat",
    "a cat sitting",
    "a cat walking",
    "a cat lying down",
  ],
  car: [
    "a white car",
    "a black car",
    "a red car",
    "a silver car",
    "a blue car",
    "a sedan",
    "an SUV",
    "a small car",
    "a large vehicle",
    "a car with open doors",
    "a car with headlights on",
    "a parked car",
    "a moving car",
  ],
  truck: [
    "a pickup truck",
    "a delivery truck",
    "a large truck",
    "a white truck",
    "a red truck",
    "a dump truck",
  ],
  bus: [
    "a city bus",
    "a school bus",
    "a shuttle bus",
    "a bus with passengers boarding",
  ],
  bicycle: [
    "a bicycle",
    "a person riding a bicycle",
    "a parked bicycle",
    "a red bicycle",
    "a black bicycle",
  ],
  motorcycle: [
    "a motorcycle",
    "a person riding a motorcycle",
    "a parked motorcycle",
    "a scooter",
  ],
  bird: [
    "a flying bird",
    "a bird on the ground",
    "a small bird",
    "a large bird",
    "a black bird",
    "a white bird",
  ],
};

/** 默认候选标签（标签不在 CANDIDATE_LABELS 中时使用） */
const DEFAULT_CANDIDATES = [
  "a large object",
  "a small object",
  "a moving object",
  "a stationary object",
  "a dark colored object",
  "a bright colored object",
  "a red object",
  "a white object",
];

/** 获取某个基础标签的候选列表 */
function getCandidatesForLabel(label: string): string[] {
  return CANDIDATE_LABELS[label] ?? DEFAULT_CANDIDATES;
}

/**
 * CLIP Service
 * 管理 CLIP Worker 线程生命周期，提供异步零样本分类
 */
export class ClipService {
  private worker: Worker | null = null;
  private initialized = false;
  private modelCacheDir: string;

  constructor(
    private config: ClipConfig,
    modelCacheDir: string,
  ) {
    this.modelCacheDir = modelCacheDir;
  }

  /** 异步初始化：预下载 + 启动 Worker 加载模型 */
  async init(): Promise<void> {
    if (!this.config.enabled) {
      console.log("[ClipService] CLIP 零样本分类已禁用");
      return;
    }

    const hfEndpoint = process.env.HF_ENDPOINT ?? "https://huggingface.co";
    /** 非 ONNX 模型由 transformers.js 自动下载 */
    await ensureModelCached(this.config.model, this.modelCacheDir, hfEndpoint);

    await this.loadModel();
    console.log(`[ClipService] 模型加载完成: ${this.config.model}`);
  }

  /** 启动 Worker 并加载模型 */
  private async loadModel(): Promise<void> {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }

    const workerPath = join(dirname(fileURLToPath(import.meta.url)), "clip-worker.ts");

    return new Promise<void>((resolve, reject) => {
      const init: ClipWorkerInit = {
        model: this.config.model,
        cacheDir: this.modelCacheDir,
        embeddingDim: this.config.embeddingDim,
      };

      const worker = new Worker(workerPath, {
        workerData: init,
      } as ConstructorParameters<typeof Worker>[1] & { workerData: unknown });

      worker.on("message", (msg: ClipWorkerResponse) => {
        if (msg.type === "ready") {
          this.worker = worker;
          this.initialized = true;
          resolve();
        } else if (msg.type === "result" && msg.id !== undefined) {
          if (msg.resultType === "image") {
            const pending = pendingEmbed.get(msg.id);
            if (pending) {
              pendingEmbed.delete(msg.id);
              if (msg.error) {
                pending.reject(new Error(msg.error));
              } else {
                pending.resolve({
                  embedding: msg.embeddings?.[0] ?? [],
                  inferMs: msg.inferMs ?? 0,
                });
              }
            }
          } else {
            const pending = pendingClassify.get(msg.id);
            if (pending) {
              pendingClassify.delete(msg.id);
              if (msg.error) {
                pending.reject(new Error(msg.error));
              } else {
                pending.resolve({
                  labels: msg.labels ?? [],
                  scores: msg.scores ?? [],
                  inferMs: msg.inferMs ?? 0,
                });
              }
            }
          }
        } else if (msg.type === "error") {
          console.error(`[ClipService] Worker 错误: ${msg.error}`);
          if (!this.initialized) {
            reject(new Error(msg.error ?? "CLIP Worker 加载失败"));
          }
        }
      });

      worker.on("error", (err: Error) => {
        console.error(`[ClipService] Worker 异常: ${err.message}`);
        if (!this.initialized) {
          reject(err);
        }
      });
    });
  }

  /**
   * 对检测目标执行零样本分类
   * @param jpeg 原始 JPEG 帧
   * @param box 检测框（归一化 0-1）
   * @param label YOLO 基础标签（如 "dog", "person"）
   * @returns 分类结果（候选标签 + 分数）
   */
  classifyTarget(
    jpeg: Buffer,
    box: { xmin: number; ymin: number; xmax: number; ymax: number },
    label: string,
  ): Promise<ZeroShotResult> {
    if (!this.initialized || !this.worker) {
      return Promise.resolve({ labels: [], scores: [], inferMs: 0 });
    }

    const id = ++requestId;
    const candidates = getCandidatesForLabel(label);

    const req: ClassifyRequest = {
      type: "zero-shot",
      id,
      image: jpeg,
      crop: box,
      labels: candidates,
    };

    return new Promise<ZeroShotResult>((resolve, reject) => {
      pendingClassify.set(id, { resolve, reject });
      this.worker!.postMessage(req);

      /** 超时保护：10 秒内未返回则丢弃 */
      setTimeout(() => {
        if (pendingClassify.has(id)) {
          pendingClassify.delete(id);
          resolve({ labels: [], scores: [], inferMs: 0 });
        }
      }, 10_000);
    });
  }

  /**
   * 提取检测目标的 CLIP 图像嵌入向量
   * 用于高精度 ReID 匹配（替代/补充 dHash 外观匹配）
   */
  imageEmbed(
    jpeg: Buffer,
    box: { xmin: number; ymin: number; xmax: number; ymax: number },
  ): Promise<ImageEmbedResult> {
    if (!this.initialized || !this.worker) {
      return Promise.resolve({ embedding: [], inferMs: 0 });
    }

    const id = ++requestId;

    const req: EmbedRequest = {
      type: "image",
      id,
      image: jpeg,
      crop: box,
    };

    return new Promise<ImageEmbedResult>((resolve, reject) => {
      pendingEmbed.set(id, { resolve, reject });
      this.worker!.postMessage(req);

      /** 超时保护：10 秒内未返回则丢弃 */
      setTimeout(() => {
        if (pendingEmbed.has(id)) {
          pendingEmbed.delete(id);
          resolve({ embedding: [], inferMs: 0 });
        }
      }, 10_000);
    });
  }

  /** 更新配置并重载模型 */
  async updateConfig(config: ClipConfig): Promise<void> {
    if (config.model !== this.config.model || config.embeddingDim !== this.config.embeddingDim) {
      this.config = config;
      if (config.enabled) {
        await this.loadModel();
      }
    } else {
      this.config = config;
    }
  }

  /** 获取 Top-K 语义标签 */
  static getTopLabels(result: ZeroShotResult, k = 3): Array<{ label: string; score: number }> {
    if (result.labels.length === 0) return [];
    const indexed = result.scores.map((score, i) => ({ label: result.labels[i]!, score }));
    indexed.sort((a, b) => b.score - a.score);
    return indexed.slice(0, k);
  }

  /** 销毁 */
  dispose(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.initialized = false;
    pendingClassify.clear();
    pendingEmbed.clear();
  }
}
