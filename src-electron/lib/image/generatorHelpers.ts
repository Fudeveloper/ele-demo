/**
 * 生成响应解析工具 —— 移植自 `ai_image_background_generator.py` 的辅助函数。
 * 候选图片提取、异步任务状态判定、base64/下载。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ProductImageGenerationError } from "../gigab2b/exceptions";
import { httpRequest } from "../http";

const MARKDOWN_IMAGE_URL = /!\[[^\]]*]\((https?:\/\/[^)\s]+)\)/;
const HTTP_IMAGE_URL = /https?:\/\/[^\s"')>]+(?:png|jpg|jpeg|webp)(?:\?[^\s"')>]*)?/i;

export type ImageCandidate = ["url" | "b64", string];

export function normalizeWireApi(wireApi: string): string {
  const clean = wireApi.toLowerCase().replace(/-/g, "_");
  if (["images_edit", "image_edit", "edit", "edits"].includes(clean)) return "images_edit";
  if (["images_generations", "images_generation", "image_generation", "images", "image"].includes(clean)) return "images_generations";
  if (["response", "responses"].includes(clean)) return "responses";
  if (["agnes", "agnes_image", "agnes_images"].includes(clean)) return "agnes_images";
  if (["chat", "chat_completion", "chat_completions", "completions"].includes(clean)) return "chat_completions";
  throw new Error(`unsupported wire_api: ${wireApi}`);
}

export function openaiBaseUrl(baseUrl: string): string {
  const clean = baseUrl.replace(/\/+$/, "");
  if (clean.endsWith("/v1/chat/completions")) return clean.slice(0, -"/chat/completions".length);
  if (clean.endsWith("/chat/completions")) return clean.slice(0, -"/chat/completions".length);
  if (clean.endsWith("/v1")) return clean;
  return `${clean}/v1`;
}

export function guessImageSuffix(url: string): string {
  let p = "";
  try {
    p = new URL(url).pathname;
  } catch {
    p = url;
  }
  const ext = path.extname(p).toLowerCase();
  return [".jpg", ".jpeg", ".png", ".webp"].includes(ext) ? ext : ".png";
}

// ============ 候选图片提取 ============

export function findGeneratedImage(
  response: Record<string, unknown>,
  excludeUrls: Set<string> = new Set(),
): ImageCandidate | null {
  const isRunningTask = isRunningTaskStatus(response);
  const runningTaskDownloadUrls = isRunningTask ? taskDownloadUrls(response) : new Set<string>();
  for (const candidate of iterLikelyImageCandidates(response)) {
    const [kind, value] = candidate;
    if (kind === "url") {
      if (excludeUrls.has(value)) continue;
      if (isRunningTask && isRunningTaskDownloadUrl(value, runningTaskDownloadUrls)) continue;
    }
    return candidate;
  }
  return null;
}

function iterLikelyImageCandidates(value: unknown): ImageCandidate[] {
  const candidates: ImageCandidate[] = [];
  const seen = new Set<string>();
  const push = (c: ImageCandidate) => {
    const key = `${c[0]}:${c[1]}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(c);
  };
  const recurse = (val: unknown, depth = 0) => {
    if (depth > 12 || val === null || val === undefined) return;
    if (typeof val === "string") {
      for (const c of extractImageCandidatesFromText(val)) push(c);
      return;
    }
    if (Array.isArray(val)) {
      for (const item of val) recurse(item, depth + 1);
      return;
    }
    if (typeof val === "object") {
      const obj = val as Record<string, unknown>;
      for (const listKey of ["data", "choices", "output", "images", "image_urls", "messages", "stream_chunks"]) {
        if (listKey === "image_urls" && Array.isArray(obj[listKey])) {
          for (const u of obj[listKey] as unknown[]) {
            if (typeof u === "string" && /^https?:\/\//.test(u)) push(["url", u]);
          }
        }
        if (obj[listKey] !== undefined) recurse(obj[listKey], depth + 1);
      }
      for (const b64Key of ["b64_json", "base64", "image_base64"]) {
        if (typeof obj[b64Key] === "string" && (obj[b64Key] as string).trim()) {
          push(["b64", (obj[b64Key] as string).trim()]);
        }
      }
      if (typeof obj.result === "string" && looksLikeImageBase64Result(obj, obj.result)) {
        push(["b64", obj.result.trim()]);
      }
      for (const urlKey of ["url", "image", "image_url"]) {
        const v = obj[urlKey];
        if (typeof v === "string") {
          if (/^https?:\/\//.test(v)) push(["url", v]);
          else for (const c of extractImageCandidatesFromText(v)) push(c);
        } else if (v && typeof v === "object") {
          const inner = (v as Record<string, unknown>).url;
          if (typeof inner === "string" && /^https?:\/\//.test(inner)) push(["url", inner]);
        }
      }
      for (const nestKey of ["content", "message", "delta", "text", "output_text"]) {
        if (obj[nestKey] !== undefined) recurse(obj[nestKey], depth + 1);
      }
    }
  };
  recurse(value);
  return candidates;
}

function looksLikeImageBase64Result(source: Record<string, unknown>, value: string): boolean {
  if (value.startsWith("data:image/")) return true;
  const typeStr = String(source.type ?? "").toLowerCase();
  return typeStr.includes("image") && value.length >= 100 && /^[A-Za-z0-9+/=\s]+$/.test(value);
}

function extractImageCandidatesFromText(text: string): ImageCandidate[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("data:image/")) return [["b64", trimmed]];
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      return iterLikelyImageCandidates(parsed);
    } catch {
      /* 回退 */
    }
  }
  const out: ImageCandidate[] = [];
  let m = MARKDOWN_IMAGE_URL.exec(trimmed);
  if (m && m[1]) out.push(["url", m[1]]);
  const httpRe = new RegExp(HTTP_IMAGE_URL);
  m = httpRe.exec(trimmed);
  if (m) out.push(["url", m[0]]);
  return out;
}

// ============ 异步任务状态 ============

const RUNNING_STATUSES = new Set(["running", "pending", "processing", "queued", "created", "submitted", "in_progress"]);
const FINISHED_STATUSES = new Set(["succeeded", "success", "completed", "complete", "done", "finished"]);
const FAILED_STATUSES = new Set(["failed", "error", "cancelled", "canceled", "timeout", "expired"]);

function taskResponseSources(response: Record<string, unknown>): Record<string, unknown>[] {
  const sources: Record<string, unknown>[] = [response];
  for (const k of ["data", "result", "task"]) {
    const v = response[k];
    if (v && typeof v === "object" && !Array.isArray(v)) sources.push(v as Record<string, unknown>);
  }
  return sources;
}

function taskStatus(response: Record<string, unknown>): string {
  for (const src of taskResponseSources(response)) {
    const s = (src.status as string) ?? (src.state as string);
    if (typeof s === "string" && s.trim()) return s.trim().toLowerCase();
  }
  return "";
}

export function isRunningTaskStatus(response: Record<string, unknown>): boolean {
  return RUNNING_STATUSES.has(taskStatus(response));
}
function isFinishedTaskStatus(response: Record<string, unknown>): boolean {
  return FINISHED_STATUSES.has(taskStatus(response));
}
function isFailedTaskStatus(response: Record<string, unknown>): boolean {
  return FAILED_STATUSES.has(taskStatus(response));
}

function firstResponseString(response: Record<string, unknown>, ...keys: string[]): string {
  for (const src of taskResponseSources(response)) {
    for (const key of keys) {
      const v = src[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return "";
}

function taskPollUrl(response: Record<string, unknown>): string {
  return firstResponseString(response, "poll_url", "pollUrl", "status_url", "statusUrl");
}
function taskDownloadUrl(response: Record<string, unknown>): string {
  return firstResponseString(response, "download_url", "downloadUrl", "detail_url", "detailUrl", "result_url", "resultUrl");
}
function taskDownloadUrls(response: Record<string, unknown>): Set<string> {
  const urls = new Set<string>();
  for (const src of taskResponseSources(response)) {
    for (const key of ["download_url", "downloadUrl", "detail_url", "detailUrl", "result_url", "resultUrl", "final_url", "finalUrl", "url", "image_url", "imageUrl"]) {
      const v = src[key];
      if (typeof v === "string" && looksLikeTaskDownloadUrl(v)) urls.add(v);
    }
    for (const key of ["image_urls", "imageUrls"]) {
      const v = src[key];
      if (Array.isArray(v)) {
        for (const u of v) if (typeof u === "string" && looksLikeTaskDownloadUrl(u)) urls.add(u);
      }
    }
  }
  return urls;
}
function looksLikeTaskDownloadUrl(url: string): boolean {
  try {
    return new URL(url).pathname.replace(/\/+$/, "").endsWith("/api/task/download");
  } catch {
    return false;
  }
}
function taskErrorMessage(response: Record<string, unknown>): string {
  return (
    firstResponseString(response, "error", "message", "msg", "detail") ||
    `image generation task failed: status=${taskStatus(response)}`
  );
}

export function shouldPollGenerationResponse(response: Record<string, unknown>): boolean {
  return isRunningTaskStatus(response) || (Boolean(taskPollUrl(response)) && !findGeneratedImage(response));
}

export function withDownloadUrlCandidate(response: Record<string, unknown>): Record<string, unknown> {
  if (findGeneratedImage(response)) return response;
  const dl = taskDownloadUrl(response);
  if (!dl) return response;
  const out = { ...response };
  if (!Array.isArray(out.data)) out.data = [];
  (out.data as unknown[]).push({ url: dl });
  return out;
}

export function mergeGenerationTaskResponse(
  previous: Record<string, unknown>,
  current: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...previous };
  for (const [k, v] of Object.entries(current)) {
    if (v !== null && v !== "" && !(Array.isArray(v) && v.length === 0)) out[k] = v;
  }
  for (const k of ["choices", "data", "messages", "images", "output"]) {
    if (k in current) out[k] = current[k];
  }
  return out;
}

function isRunningTaskDownloadUrl(url: string, set: Set<string>): boolean {
  return set.has(url) || looksLikeTaskDownloadUrl(url);
}

export { isFailedTaskStatus, isFinishedTaskStatus, taskPollUrl, taskErrorMessage };

// ============ base64 / 下载 ============

export function decodeBase64Image(value: string): Buffer {
  let data = value;
  if (data.startsWith("data:image/")) data = data.split(",", 2)[1] ?? "";
  try {
    return Buffer.from(data, "base64");
  } catch {
    throw new ProductImageGenerationError("generated image base64 is invalid");
  }
}

export async function downloadBinary(
  url: string,
  outputPath: string,
  pollInterval: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let currentUrl = url;
  for (;;) {
    if (Date.now() >= deadline) {
      throw new ProductImageGenerationError(`image download timed out: ${currentUrl}`);
    }
    const reqTimeout = Math.min(120000, Math.max(1000, deadline - Date.now()));
    const resp = await httpRequest(currentUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 GigaB2B AI image generator",
        Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      },
      timeoutMs: reqTimeout,
    });
    if (!resp.ok) throw new ProductImageGenerationError(`image download failed: HTTP ${resp.status}`);
    let parsed: Record<string, unknown> | null = null;
    const ct = resp.headers.get("content-type") ?? "";
    if (ct.includes("json") || (resp.text.trimStart().startsWith("{") && !resp.bytes.length)) {
      try {
        parsed = JSON.parse(resp.text) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
    }
    if (!parsed) {
      mkdirSync(path.dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, Buffer.from(resp.bytes));
      return;
    }
    const candidate = findGeneratedImage(parsed) ?? downloadResponseImageCandidate(parsed);
    if (candidate) {
      const [kind, value] = candidate;
      if (kind === "b64") {
        mkdirSync(path.dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, decodeBase64Image(value));
        return;
      }
      if (value === currentUrl) {
        throw new ProductImageGenerationError(`image download url points to the same url: ${value}`);
      }
      currentUrl = value;
      continue;
    }
    if (!isRetryableDownloadResponse(parsed)) {
      throw new ProductImageGenerationError(downloadResponseErrorMessage(parsed));
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new ProductImageGenerationError(`image download timed out: ${currentUrl}`);
    await sleep(Math.min(pollInterval * 1000, remaining));
  }
}

function downloadResponseImageCandidate(response: Record<string, unknown>): ImageCandidate | null {
  for (const key of ["data", "result", "file", "file_url", "download_url", "downloadUrl", "detail_url", "detailUrl", "result_url", "resultUrl"]) {
    const v = response[key];
    if (typeof v === "string") {
      const cands = extractImageCandidatesFromText(v);
      if (cands.length && cands[0]) return cands[0];
      if (/^https?:\/\//.test(v)) return ["url", v];
    }
  }
  return null;
}

function isRetryableDownloadResponse(response: Record<string, unknown>): boolean {
  if (isRunningTaskStatus(response)) return true;
  const msg = firstResponseString(response, "message", "msg", "detail", "error").toLowerCase();
  if (msg.includes("task result file not found") || (msg.includes("result file") && msg.includes("not found"))) return true;
  if (response.success === false) {
    return ["not ready", "running", "processing", "pending", "queued"].some((s) => msg.includes(s));
  }
  return false;
}

function downloadResponseErrorMessage(response: Record<string, unknown>): string {
  const errObj = response.error;
  if (errObj && typeof errObj === "object") {
    const m = (errObj as Record<string, unknown>).message;
    if (typeof m === "string") return m;
  }
  if (typeof errObj === "string") return errObj;
  const msg = firstResponseString(response, "message", "msg", "detail");
  return msg || "generated image download response did not contain image binary or image url";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
