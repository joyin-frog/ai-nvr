import { createWriteStream, existsSync, mkdirSync, statSync, renameSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { get as httpsGet } from "node:https";
import { get as httpGet } from "node:http";

/** 模型下载所需的文件列表 */
const MODEL_FILES = ["config.json", "preprocessor_config.json", "onnx/model.onnx"];

/**
 * 健壮地下载模型文件，支持断点续传和重试
 * 下载完成后 transformers.js 会直接从缓存目录读取，无需重复下载
 */
export async function ensureModelCached(
  modelId: string,
  cacheDir: string,
  endpoint?: string,
): Promise<void> {
  const hfHost = endpoint ?? process.env.HF_ENDPOINT ?? "https://hf-mirror.com";
  const modelDir = join(cacheDir, modelId);

  for (const file of MODEL_FILES) {
    const filePath = join(modelDir, file);
    const tmpPath = filePath + ".downloading";

    /** 检查是否已存在完整文件 */
    if (existsSync(filePath)) {
      const stat = statSync(filePath);
      /** 小文件（配置）>100字节视为完整，大文件至少 >1MB */
      const minSize = file.endsWith(".onnx") ? 1_000_000 : 100;
      if (stat.size > minSize) continue;
      /** 文件太小，可能损坏，删除重下 */
      console.log(`[ModelDownloader] ${file} 文件不完整 (${stat.size}B)，重新下载`);
      unlinkSync(filePath);
    }

    const url = `${hfHost}/${modelId}/resolve/main/${file}`;
    console.log(`[ModelDownloader] 下载 ${file} ...`);

    await downloadWithResume(url, tmpPath, filePath);
    console.log(`[ModelDownloader] ${file} 下载完成`);
  }
}

/**
 * 支持 HTTP 断点续传和重试的下载
 * 使用 Range header 从上次中断位置继续
 */
function downloadWithResume(url: string, tmpPath: string, finalPath: string, maxRetries = 5): Promise<void> {
  return new Promise((resolve, reject) => {
    let attempt = 0;

    const tryDownload = () => {
      attempt++;
      /** 检查临时文件大小，用于断点续传 */
      let startByte = 0;
      if (existsSync(tmpPath)) {
        startByte = statSync(tmpPath).size;
      }

      const parsedUrl = new URL(url);
      const get = parsedUrl.protocol === "https:" ? httpsGet : httpGet;

      const headers: Record<string, string> = {};
      if (startByte > 0) {
        headers.Range = `bytes=${startByte}-`;
        console.log(`[ModelDownloader] 断点续传 from byte ${startByte} (attempt ${attempt})`);
      }

      const req = get(url, { headers }, (res) => {
        /** 处理重定向 */
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          req.destroy();
          /** 重定向可能是相对路径，需要拼接完整 URL */
          let redirectUrl = res.headers.location;
          if (redirectUrl.startsWith("/")) {
            redirectUrl = `${parsedUrl.protocol}//${parsedUrl.host}${redirectUrl}`;
          }
          downloadWithResume(redirectUrl, tmpPath, finalPath, maxRetries - attempt + 1)
            .then(resolve)
            .catch(reject);
          return;
        }

        /** 服务器不支持 Range，从头开始 */
        if (res.statusCode === 200) {
          startByte = 0;
        }

        if (res.statusCode !== 200 && res.statusCode !== 206) {
          req.destroy();
          if (attempt < maxRetries) {
            console.log(`[ModelDownloader] HTTP ${res.statusCode}，${3}s 后重试...`);
            setTimeout(tryDownload, 3000);
            return;
          }
          reject(new Error(`下载失败: HTTP ${res.statusCode}`));
          return;
        }

        const flags = startByte > 0 ? "a" : "w";
        const ws = createWriteStream(tmpPath, { flags });
        let downloaded = startByte;
        const total = parseInt(res.headers["content-length"] ?? "0") + startByte;

        res.on("data", (chunk: Buffer) => {
          downloaded += chunk.length;
          if (total > 0 && downloaded % 5_000_000 < chunk.length) {
            const pct = ((downloaded / total) * 100).toFixed(1);
            console.log(`[ModelDownloader] ${downloaded}/${total} bytes (${pct}%)`);
          }
        });

        ws.on("error", (err) => {
          req.destroy();
          if (attempt < maxRetries) {
            console.log(`[ModelDownloader] 写入错误: ${err.message}，重试...`);
            setTimeout(tryDownload, 3000);
          } else {
            reject(err);
          }
        });

        res.pipe(ws);

        res.on("end", () => {
          ws.close();
          /** 检查下载是否完整 */
          if (total > 0 && existsSync(tmpPath)) {
            const finalSize = statSync(tmpPath).size;
            if (finalSize < total - 1) {
              if (attempt < maxRetries) {
                console.log(`[ModelDownloader] 下载不完整 (${finalSize}/${total})，重试...`);
                setTimeout(tryDownload, 3000);
                return;
              }
            }
          }
          /** 原子重命名为最终文件名 */
          mkdirSync(dirname(finalPath), { recursive: true });
          renameSync(tmpPath, finalPath);
          resolve();
        });

        res.on("error", (err) => {
          ws.close();
          if (attempt < maxRetries) {
            console.log(`[ModelDownloader] 网络错误: ${err.message}，重试...`);
            setTimeout(tryDownload, 3000);
          } else {
            reject(err);
          }
        });
      });

      req.on("error", (err) => {
        if (attempt < maxRetries) {
          console.log(`[ModelDownloader] 请求错误: ${err.message}，重试...`);
          setTimeout(tryDownload, 3000);
        } else {
          reject(err);
        }
      });

      /** 超时 30 秒 */
      req.setTimeout(30_000, () => {
        req.destroy();
        if (attempt < maxRetries) {
          console.log(`[ModelDownloader] 请求超时，重试...`);
          setTimeout(tryDownload, 3000);
        } else {
          reject(new Error("下载超时"));
        }
      });
    };

    tryDownload();
  });
}
