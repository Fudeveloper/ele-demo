/**
 * ImgBB 图床上传 —— 移植自 `imgbb_uploader.py`。
 */

import { readFileSync } from "node:fs";

const DEFAULT_IMGBB_API_URL = "https://api.imgbb.com/1/upload";

export interface UploadToImgbbOptions {
  filePath: string;
  apiKey?: string;
  apiUrl?: string;
  timeout?: number;
}

export async function uploadToImgbb(opts: UploadToImgbbOptions): Promise<string> {
  const apiKey = opts.apiKey ?? "";
  const apiUrl = opts.apiUrl ?? DEFAULT_IMGBB_API_URL;
  const timeout = opts.timeout ?? 60000;
  if (!apiKey) throw new Error("IMGBB_UPLOAD_API_KEY 未配置");

  const body = readFileSync(opts.filePath);
  const encoded = Buffer.from(body).toString("base64");

  const form = new URLSearchParams();
  form.set("key", apiKey);
  form.set("image", encoded);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let resp: Response;
  try {
    resp = await fetch(`${apiUrl}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(`图床上传失败: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  const result = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  if (!resp.ok) {
    const errObj = (result.error as Record<string, unknown>) ?? {};
    const detail = (errObj.message as string) ?? JSON.stringify(result).slice(0, 200);
    throw new Error(`图床上传失败 (HTTP ${resp.status}): ${detail}`);
  }
  return extractDisplayUrl(result);
}

function extractDisplayUrl(result: Record<string, unknown>): string {
  const data = (result.data as Record<string, unknown>) ?? {};
  for (const key of ["display_url", "url", "medium", "thumb"]) {
    const url = data[key];
    if (typeof url === "string" && url.startsWith("http")) return url;
  }
  throw new Error(`图床响应中未找到图片 URL: ${JSON.stringify(result).slice(0, 300)}`);
}
