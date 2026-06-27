/**
 * 图片背景生成器（wire-level）—— 移植自 `ai_image_background_generator.py`。
 * OpenAI 兼容 REST（不依赖 SDK），支持多种 wire API、异步任务轮询、流式、base64/URL 提取。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ProductImageGenerationError } from "../gigab2b/exceptions";
import { httpRequest, httpRequestJson, httpRequestStream } from "../http";
import { DEFAULT_BACKGROUND_PROMPT } from "./prompts";
import {
  decodeBase64Image,
  downloadBinary,
  findGeneratedImage,
  isFailedTaskStatus,
  isFinishedTaskStatus,
  mergeGenerationTaskResponse,
  normalizeWireApi,
  openaiBaseUrl,
  shouldPollGenerationResponse,
  taskErrorMessage,
  taskPollUrl,
  withDownloadUrlCandidate,
  type ImageCandidate,
} from "./generatorHelpers";

export { DEFAULT_BACKGROUND_PROMPT };
export type { ImageCandidate };

export interface GenerationRequestOptions {
  [key: string]: unknown;
}

export interface ProductImageBackgroundGeneratorOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  wireApi: string;
  outputRoot: string;
  timeout?: number;
  pollInterval?: number;
  prompt: string;
  requestOptions?: GenerationRequestOptions;
}

export class ProductImageBackgroundGenerator {
  apiKey: string;
  baseUrl: string;
  model: string;
  wireApi: string;
  outputRoot: string;
  timeout: number;
  pollInterval: number;
  prompt: string;
  requestOptions: GenerationRequestOptions;

  constructor(opts: ProductImageBackgroundGeneratorOptions) {
    if (!opts.apiKey) throw new Error("api_key is required");
    if (!opts.baseUrl) throw new Error("base_url is required");
    if (!opts.model) throw new Error("model is required");
    if (!opts.prompt.trim()) throw new Error("prompt is required");
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.model = opts.model;
    this.wireApi = normalizeWireApi(opts.wireApi);
    this.outputRoot = opts.outputRoot;
    this.timeout = opts.timeout ?? 180000;
    this.pollInterval = Math.max(0, opts.pollInterval ?? 2);
    this.prompt = opts.prompt.trim();
    this.requestOptions = { ...(opts.requestOptions ?? {}) };
  }

  buildPayload(sourceUrl: string, prompt: string): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      model: this.model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt.trim() },
            { type: "image_url", image_url: { url: sourceUrl } },
          ],
        },
      ],
      stream: false,
    };
    Object.assign(payload, this.requestOptions);
    return payload;
  }

  async requestGeneration(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { url, body, headers, isStream } = this.buildHttpRequest(payload);
    let parsed: Record<string, unknown>;
    if (isStream) {
      parsed = await this.collectStreamResponse(url, { method: "POST", headers, body });
    } else {
      parsed = await httpRequestJson<Record<string, unknown>>(url, {
        method: "POST",
        headers,
        body,
        timeoutMs: this.timeout,
      });
    }
    return this.resolveAsyncGenerationResponse(parsed);
  }

  async saveGeneratedImage(response: Record<string, unknown>, outputPath: string, sourceUrl = ""): Promise<void> {
    const excludeUrls = sourceUrl ? new Set([sourceUrl]) : new Set<string>();
    const candidate = findGeneratedImage(response, excludeUrls);
    if (!candidate) throw new ProductImageGenerationError("image generation response did not contain an image");
    const [kind, value] = candidate;
    mkdirSync(path.dirname(outputPath), { recursive: true });
    if (kind === "b64") {
      writeFileSync(outputPath, decodeBase64Image(value));
    } else if (kind === "url") {
      await downloadBinary(value, outputPath, this.pollInterval, this.timeout);
    } else {
      throw new ProductImageGenerationError(`unsupported image candidate kind: ${kind}`);
    }
  }

  private resolveEndpoint(): string {
    const base = openaiBaseUrl(this.baseUrl);
    switch (this.wireApi) {
      case "images_edit":
        return `${base}/images/edits`;
      case "images_generations":
      case "agnes_images":
        return `${base}/images/generations`;
      case "responses":
        return `${base}/responses`;
      default:
        return `${base}/chat/completions`;
    }
  }

  private buildHttpRequest(payload: Record<string, unknown>): {
    url: string;
    body: string;
    headers: Record<string, string>;
    isStream: boolean;
  } {
    const { kwargs, extraBody } = openaiRequestKwargs(payload, this.wireApi);
    const url = this.resolveEndpoint();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
    const finalBody: Record<string, unknown> = { ...kwargs };
    if (Object.keys(extraBody).length) {
      for (const [k, v] of Object.entries(extraBody)) {
        if (!(k in finalBody)) finalBody[k] = v;
      }
    }
    const isStream = Boolean(finalBody.stream);
    return { url, body: JSON.stringify(finalBody), headers, isStream };
  }

  private async collectStreamResponse(
    url: string,
    opts: { method: string; headers: Record<string, string>; body: string },
  ): Promise<Record<string, unknown>> {
    const { status, body } = await httpRequestStream(url, {
      method: opts.method,
      headers: opts.headers,
      body: opts.body,
      timeoutMs: this.timeout,
    });
    if (!body || status >= 400) {
      throw new ProductImageGenerationError(`image generation stream request failed: HTTP ${status}`);
    }
    const chunks: Record<string, unknown>[] = [];
    const contentParts: string[] = [];
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const chunk = JSON.parse(data) as Record<string, unknown>;
          chunks.push(chunk);
          contentParts.push(...extractStreamTextParts(chunk));
        } catch {
          /* 忽略 */
        }
      }
    }
    return {
      choices: [{ message: { content: contentParts.join("") } }],
      stream_chunks: chunks,
    };
  }

  private async resolveAsyncGenerationResponse(
    response: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!shouldPollGenerationResponse(response)) {
      return withDownloadUrlCandidate(response);
    }
    let pollUrl = taskPollUrl(response);
    if (!pollUrl) {
      throw new ProductImageGenerationError("image generation task is running but poll_url is missing");
    }
    const deadline = Date.now() + this.timeout;
    let current = response;
    for (;;) {
      if (isFailedTaskStatus(current)) {
        throw new ProductImageGenerationError(taskErrorMessage(current));
      }
      if (findGeneratedImage(current)) return current;
      if (isFinishedTaskStatus(current)) return withDownloadUrlCandidate(current);
      if (Date.now() >= deadline) {
        const tid = (current.task_id as string) ?? (response.task_id as string) ?? "";
        throw new ProductImageGenerationError(`image generation task timed out: ${tid}`);
      }
      if (this.pollInterval) await sleep(this.pollInterval * 1000);
      const polled = await this.requestTaskStatus(pollUrl);
      current = mergeGenerationTaskResponse(current, polled);
      pollUrl = taskPollUrl(current) || pollUrl;
    }
  }

  private async requestTaskStatus(pollUrl: string): Promise<Record<string, unknown>> {
    const resp = await httpRequest(pollUrl, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: "application/json, text/plain, */*",
      },
      timeoutMs: 30000,
    });
    let parsed: unknown;
    try {
      parsed = resp.text ? JSON.parse(resp.text) : {};
    } catch {
      throw new ProductImageGenerationError("image task poll response is not a JSON object");
    }
    if (!parsed || typeof parsed !== "object") {
      throw new ProductImageGenerationError("image task poll response is not a JSON object");
    }
    return parsed as Record<string, unknown>;
  }
}

// ============ wire API payload 拆分 ============

const CHAT_SUPPORTED = new Set([
  "model", "messages", "stream", "temperature", "top_p", "frequency_penalty",
  "presence_penalty", "max_tokens", "max_completion_tokens", "response_format",
  "seed", "stop", "tools", "tool_choice",
]);
const RESPONSES_SUPPORTED = new Set([
  "model", "input", "stream", "temperature", "top_p", "max_output_tokens",
  "max_tool_calls", "metadata", "parallel_tool_calls", "previous_response_id",
  "reasoning", "response_format", "seed", "text", "tool_choice", "tools",
  "truncation", "user",
]);
const IMAGES_GENERATION_SUPPORTED = new Set([
  "model", "prompt", "n", "size", "quality", "response_format", "style", "user",
  "background", "moderation", "output_compression", "output_format",
]);
const IMAGES_EDIT_SUPPORTED = new Set([
  "model", "image", "image_source", "mask", "prompt", "n", "size",
  "response_format", "quality", "user",
]);
const AGNES_SUPPORTED = new Set(["model", "prompt", "n", "size", "quality", "style", "user"]);

export function openaiRequestKwargs(
  payload: Record<string, unknown>,
  wireApi: string,
): { kwargs: Record<string, unknown>; extraBody: Record<string, unknown> } {
  switch (wireApi) {
    case "images_edit":
      return openaiImagesEditKwargs(payload);
    case "images_generations":
      return openaiImagesGenerationKwargs(payload);
    case "agnes_images":
      return openaiAgnesKwargs(payload);
    case "responses":
      return openaiResponsesKwargs(payload);
    default:
      return openaiChatKwargs(payload);
  }
}

function openaiChatKwargs(payload: Record<string, unknown>) {
  const kwargs: Record<string, unknown> = {};
  const extraBody: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (CHAT_SUPPORTED.has(k)) kwargs[k] = v;
    else extraBody[k] = v;
  }
  return { kwargs, extraBody };
}

function openaiResponsesKwargs(payload: Record<string, unknown>) {
  const kwargs: Record<string, unknown> = {};
  const extraBody: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (k === "messages") continue;
    if (RESPONSES_SUPPORTED.has(k)) kwargs[k] = v;
    else extraBody[k] = v;
  }
  if (payload.messages && !kwargs.input) {
    kwargs.input = messagesToResponsesInput(payload.messages as unknown[]);
  }
  if (payload.max_tokens && !kwargs.max_output_tokens) kwargs.max_output_tokens = payload.max_tokens;
  if (payload.max_completion_tokens && !kwargs.max_output_tokens) {
    kwargs.max_output_tokens = payload.max_completion_tokens;
  }
  if (!kwargs.input) throw new ProductImageGenerationError("responses payload requires input");
  return { kwargs, extraBody };
}

function openaiImagesGenerationKwargs(payload: Record<string, unknown>) {
  const kwargs: Record<string, unknown> = {};
  const extraBody: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (k === "messages" || k === "stream") continue;
    if (IMAGES_GENERATION_SUPPORTED.has(k)) kwargs[k] = v;
    else extraBody[k] = v;
  }
  if (payload.messages && !kwargs.prompt) {
    kwargs.prompt = messagesToImagesPrompt(payload.messages as unknown[]);
  }
  if (!kwargs.prompt) throw new ProductImageGenerationError("images payload requires prompt");
  if (!kwargs.size) kwargs.size = "1024x1024";
  if (!kwargs.n) kwargs.n = 1;
  return { kwargs, extraBody };
}

function openaiImagesEditKwargs(payload: Record<string, unknown>) {
  const kwargs: Record<string, unknown> = {};
  const extraBody: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (k === "messages" || k === "stream") continue;
    if (IMAGES_EDIT_SUPPORTED.has(k)) kwargs[k] = v;
    else extraBody[k] = v;
  }
  const messages = payload.messages as unknown[];
  if (messages && !kwargs.prompt) kwargs.prompt = messagesToImagesPrompt(messages);
  if (messages && !kwargs.image_source && !kwargs.image) {
    const url = firstImageUrlFromMessages(messages);
    if (url) kwargs.image_source = url;
  }
  if (!kwargs.prompt) throw new ProductImageGenerationError("images edit payload requires prompt");
  if (!kwargs.image_source && !kwargs.image) {
    throw new ProductImageGenerationError("images edit payload requires image");
  }
  if (!kwargs.n) kwargs.n = 1;
  return { kwargs, extraBody };
}

function openaiAgnesKwargs(payload: Record<string, unknown>) {
  const kwargs: Record<string, unknown> = {};
  const extraBodyInner: Record<string, unknown> = {};
  const imageUrls: string[] = [];
  for (const [k, v] of Object.entries(payload)) {
    if (k === "messages" || k === "stream") continue;
    if (AGNES_SUPPORTED.has(k)) kwargs[k] = v;
    else extraBodyInner[k] = v;
  }
  if (payload.messages) {
    const { textParts, urls } = messagesToPromptAndImages(payload.messages as unknown[]);
    if (!kwargs.prompt) kwargs.prompt = textParts;
    imageUrls.push(...urls);
  }
  if (!kwargs.prompt) throw new ProductImageGenerationError("agnes payload requires prompt");
  if (imageUrls.length) extraBodyInner.image = imageUrls;
  if (!kwargs.size) kwargs.size = "1024x1024";
  if (!kwargs.n) kwargs.n = 1;
  return { kwargs, extraBody: extraBodyInner };
}

// ============ messages 转换 ============

function messagesToResponsesInput(messages: unknown[]): unknown[] {
  return messages.map((m) => {
    const msg = m as Record<string, unknown>;
    return {
      role: (msg.role as string) || "user",
      content: messageContentToResponsesContent(msg.content),
    };
  });
}

function messageContentToResponsesContent(content: unknown): unknown[] {
  if (typeof content === "string") return [{ type: "input_text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.map((item) => {
    const it = item as Record<string, unknown>;
    const type = it.type as string;
    if (type === "text") return { type: "input_text", text: it.text };
    if (type === "image_url") {
      const iu = it.image_url as Record<string, unknown>;
      return { type: "input_image", image_url: iu?.url ?? "" };
    }
    return { ...it };
  });
}

function messagesToImagesPrompt(messages: unknown[]): string {
  const { textParts, urls } = messagesToPromptAndImages(messages);
  let prompt = textParts;
  if (urls.length) prompt += `\n\nReference product image URL(s): ${urls.join(", ")}`;
  return prompt;
}

function messagesToPromptAndImages(messages: unknown[]): { textParts: string; urls: string[] } {
  const texts: string[] = [];
  const urls: string[] = [];
  for (const m of messages) {
    const msg = m as Record<string, unknown>;
    const { texts: t, urls: u } = messageContentToPromptParts(msg.content);
    texts.push(...t);
    urls.push(...u);
  }
  const textParts = texts.map((s) => s.trim()).filter(Boolean).join("\n\n");
  if (!textParts) throw new ProductImageGenerationError("messages have no text content");
  return { textParts, urls };
}

function messageContentToPromptParts(content: unknown): { texts: string[]; urls: string[] } {
  const texts: string[] = [];
  const urls: string[] = [];
  if (typeof content === "string") {
    texts.push(content);
  } else if (Array.isArray(content)) {
    for (const item of content) {
      const it = item as Record<string, unknown>;
      const type = it.type as string;
      if (type === "text" || type === "input_text" || type === "output_text") {
        if (typeof it.text === "string") texts.push(it.text);
      } else if (type === "image_url" || type === "input_image") {
        const iu = it.image_url as Record<string, unknown>;
        const url = typeof iu === "string" ? iu : (iu?.url as string);
        if (typeof url === "string" && url) urls.push(url);
      }
    }
  }
  return { texts, urls };
}

function firstImageUrlFromMessages(messages: unknown[]): string {
  for (const m of messages) {
    const { urls } = messageContentToPromptParts((m as Record<string, unknown>).content);
    if (urls.length && urls[0]) return urls[0];
  }
  return "";
}

function extractStreamTextParts(value: unknown): string[] {
  const parts: string[] = [];
  const recurse = (val: unknown) => {
    if (!val) return;
    if (typeof val === "string") {
      parts.push(val);
      return;
    }
    if (Array.isArray(val)) {
      for (const item of val) recurse(item);
      return;
    }
    if (typeof val === "object") {
      const obj = val as Record<string, unknown>;
      if (obj.choices) recurse(obj.choices);
      if (obj.delta) recurse(obj.delta);
      if (obj.message) recurse(obj.message);
      if (obj.content) parts.push(...contentTextParts(obj.content));
      if (typeof obj.text === "string") parts.push(obj.text);
    }
  };
  recurse(value);
  return parts;
}

function contentTextParts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (Array.isArray(content)) {
    const out: string[] = [];
    for (const item of content) {
      const it = item as Record<string, unknown>;
      if (typeof it?.text === "string") out.push(it.text);
      else if (it && typeof it === "object") out.push(...contentTextParts(it));
    }
    return out;
  }
  return [];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
