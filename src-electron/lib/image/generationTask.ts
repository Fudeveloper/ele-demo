/**
 * 图片生成任务编排 —— 移植自 `services.py` 的 image-generation 相关函数。
 *
 * 流程：分类源图 -> 描述场景 -> 提取主色 -> 组装 prompt -> 生成 ->
 * 保存 -> 归一化 -> (镜像) -> (信息区域保护)。
 */

import path from "node:path";
import { ProductImageBackgroundGenerator } from "./generator";
import {
  classifySourceImageWithVision,
  describeSceneWithVision,
} from "./analysis";
import {
  extractProductColors,
  mirrorOutput,
  normalizeGeneratedImage,
  preserveInformationRegions,
  sourceLooksLikeInformationImage,
} from "./imageProcessing";
import { imageGenerationPrompt } from "./prompts";
import { ProductImageGenerationError } from "../gigab2b/exceptions";

export interface ImageGenerationTask {
  productId: number;
  itemCode: string;
  accountId: number;
  clientId: string;
  clientSecret: string;
  openapiBaseUrl: string;
  sourceUrl: string;
  imageIndex: number;
  originalUrl: string;
  outputRoot: string;
  outputPath: string;
  storedPath: string;
  apiKey: string;
  imageApiBaseUrl: string;
  imageApiModel: string;
  imageApiWireApi: string;
  imageApiGroup: string;
  imageApiStream: boolean;
  imageApiTimeout: number;
  imageApiPollInterval: number;
  outputSize: [number, number];
  disableFlip: boolean;
  flip: boolean;
  imageAnalysisEnabled: boolean;
  imageAnalysisBaseUrl: string;
  imageAnalysisModel: string;
  imageAnalysisApiKey: string;
  imageAnalysisTimeout: number;
}

export interface ImageSourceClassification {
  informationMode: boolean;
  localInformation: boolean;
  visionMode: string;
  visionConfidence: number;
  method: "local" | "vision";
  reason: string;
}

export interface ImageGenerationResult {
  productId: number;
  itemCode: string;
  imageIndex: number;
  originalUrl: string;
  storedPath: string;
  success: boolean;
  error: string;
  durationMs: number;
}

export const IMAGE_GENERATION_SUBMIT_RETRIES = 3;
export const IMAGE_GENERATION_SUBMIT_RETRY_INTERVAL_SECONDS = 1.0;
const RATE_LIMIT_MAX_RETRIES = 5;
const RATE_LIMIT_SLEEP_SECONDS = 3.0;

export function imageGenerationWireApiSupportsSize(wireApi: string): boolean {
  const clean = wireApi.toLowerCase().replace(/-/g, "_");
  return ["image", "images", "image_generation", "images_generation", "images_generations", "edit", "edits", "image_edit", "images_edit"].includes(clean);
}

export function imageGenerationRequestOptions(task: ImageGenerationTask): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  if (task.imageApiGroup.trim()) options.group = task.imageApiGroup;
  if (task.imageApiStream) options.stream = true;
  if (imageGenerationWireApiSupportsSize(task.imageApiWireApi)) {
    const [w, h] = task.outputSize;
    options.size = `${w}x${h}`;
  }
  return options;
}

export async function classifySourceImageForGeneration(task: ImageGenerationTask): Promise<ImageSourceClassification> {
  const localInformation = await sourceLooksLikeInformationImage(task.originalUrl);
  if (localInformation) {
    return {
      informationMode: true,
      localInformation: true,
      visionMode: "",
      visionConfidence: 0,
      method: "local",
      reason: "local information markers detected",
    };
  }
  if (!task.imageAnalysisEnabled) {
    return {
      informationMode: false,
      localInformation: false,
      visionMode: "",
      visionConfidence: 0,
      method: "local",
      reason: "vision classification disabled",
    };
  }
  const vision = await classifySourceImageWithVision(task.sourceUrl, {
    apiKey: task.imageAnalysisApiKey || task.apiKey,
    baseUrl: task.imageAnalysisBaseUrl || task.imageApiBaseUrl,
    model: task.imageAnalysisModel || "agnes-2.0-flash",
    timeout: task.imageAnalysisTimeout,
  });
  if (!vision) {
    return {
      informationMode: false,
      localInformation: false,
      visionMode: "",
      visionConfidence: 0,
      method: "local",
      reason: "vision classification unavailable",
    };
  }
  const visionMode = String(vision.mode ?? "");
  const visionConfidence = Number(vision.confidence ?? 0);
  const informationMode = visionMode === "information" && visionConfidence >= 0.5;
  return {
    informationMode,
    localInformation: false,
    visionMode,
    visionConfidence,
    method: "vision",
    reason: String(vision.reason ?? ""),
  };
}

export async function describeSceneForProduct(task: ImageGenerationTask): Promise<{ scene: string; product: string }> {
  if (!task.imageAnalysisEnabled) return { scene: "", product: "" };
  const result = await describeSceneWithVision(task.sourceUrl, {
    imageIndex: task.imageIndex,
    apiKey: task.imageAnalysisApiKey || task.apiKey,
    baseUrl: task.imageAnalysisBaseUrl || task.imageApiBaseUrl,
    model: task.imageAnalysisModel || "agnes-2.0-flash",
    timeout: task.imageAnalysisTimeout,
  });
  if (!result.scene) return { scene: "", product: "" };
  return result;
}

/** 错误分类。 */
export function isRateLimitError(err: unknown): boolean {
  let e: unknown = err;
  while (e) {
    const s = String((e as Error).message ?? e).toLowerCase();
    if (s.includes("429") || s.includes("rate")) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

export function isContentPolicyError(err: unknown): boolean {
  let e: unknown = err;
  while (e) {
    const s = String((e as Error).message ?? e).toLowerCase();
    if (s.includes("content_policy_violation") || s.includes("unable to generate this content")) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

export function isServiceUnavailableError(err: unknown): boolean {
  let e: unknown = err;
  while (e) {
    const s = String((e as Error).message ?? e).toLowerCase();
    if (
      s.includes("503") ||
      s.includes("serviceunavailableerror") ||
      s.includes("no available server") ||
      s.includes("service unavailable") ||
      s.includes("502") ||
      s.includes("504") ||
      s.includes("bad gateway") ||
      s.includes("gateway timeout")
    ) {
      return true;
    }
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

export function friendlyGenerationErrorMessage(err: unknown): string {
  const raw = String((err as Error).message ?? err);
  if (isServiceUnavailableError(err)) {
    return `图像服务暂时不可用（503，无可用服务器），请稍后重试该图。 原始错误：${raw.slice(0, 200)}`;
  }
  if (isContentPolicyError(err)) {
    return `内容审核未通过（content_policy_violation），该图无法生成。 原始错误：${raw.slice(0, 200)}`;
  }
  if (isRateLimitError(err)) {
    return `请求过于频繁被限流（429），请稍后重试该图。 原始错误：${raw.slice(0, 200)}`;
  }
  return raw;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 带重试地请求生成（内容审核不重试，503 指数退避，其它 1s）。 */
export async function requestImageGenerationWithRetries(
  generator: ProductImageBackgroundGenerator,
  payload: Record<string, unknown>,
  retries = IMAGE_GENERATION_SUBMIT_RETRIES,
  intervalSeconds = IMAGE_GENERATION_SUBMIT_RETRY_INTERVAL_SECONDS,
): Promise<Record<string, unknown>> {
  const maxAttempts = retries + 1;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await generator.requestGeneration(payload);
    } catch (err) {
      if (isContentPolicyError(err)) throw err;
      lastErr = err;
      if (attempt >= maxAttempts) break;
      let wait = intervalSeconds;
      if (isServiceUnavailableError(err)) {
        wait = Math.min(2 * 2 ** (attempt - 1), 15);
      }
      if (wait > 0) await sleep(wait * 1000);
    }
  }
  throw lastErr;
}

/** 执行单个图片生成任务（完整流程）。返回结果（不负责上传到图床）。 */
export async function executeImageGenerationTask(task: ImageGenerationTask): Promise<ImageGenerationResult> {
  const startedAt = Date.now();
  const baseResult: ImageGenerationResult = {
    productId: task.productId,
    itemCode: task.itemCode,
    imageIndex: task.imageIndex,
    originalUrl: task.originalUrl,
    storedPath: task.storedPath,
    success: false,
    error: "",
    durationMs: 0,
  };
  try {
    const requestOptions = imageGenerationRequestOptions(task);
    const classification = await classifySourceImageForGeneration(task);
    const informationMode = classification.informationMode;
    const sceneInfo = await describeSceneForProduct(task);
    const colorHint = await extractProductColors(task.sourceUrl);
    const prompt = imageGenerationPrompt(task.outputSize, {
      informationMode,
      sceneHint: sceneInfo.scene,
      productSubject: sceneInfo.product,
      colorHint,
    });

    const generator = new ProductImageBackgroundGenerator({
      apiKey: task.apiKey,
      baseUrl: task.imageApiBaseUrl,
      model: task.imageApiModel,
      wireApi: task.imageApiWireApi,
      outputRoot: task.outputRoot,
      timeout: task.imageApiTimeout * 1000,
      pollInterval: task.imageApiPollInterval,
      prompt,
      requestOptions,
    });
    const payload = generator.buildPayload(task.sourceUrl, prompt);
    const response = await requestImageGenerationWithRetries(generator, payload);
    await generator.saveGeneratedImage(response, task.outputPath, task.sourceUrl);
    await normalizeGeneratedImage(task.outputPath, task.outputSize);
    if (task.flip) {
      await mirrorOutput(task.outputPath);
    }
    if (informationMode) {
      await preserveInformationRegions(task.outputPath, task.originalUrl, task.outputSize);
    }
    return {
      ...baseResult,
      success: true,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      ...baseResult,
      error: friendlyGenerationErrorMessage(err),
      durationMs: Date.now() - startedAt,
    };
  }
}

/** 限流重试的 worker（外层）。 */
export async function executeImageGenerationTaskWithRateRetry(task: ImageGenerationTask): Promise<ImageGenerationResult> {
  for (let attempt = 1; attempt <= RATE_LIMIT_MAX_RETRIES; attempt++) {
    try {
      return await executeImageGenerationTask(task);
    } catch (err) {
      if (attempt < RATE_LIMIT_MAX_RETRIES && isRateLimitError(err)) {
        await sleep(RATE_LIMIT_SLEEP_SECONDS * 1000);
        continue;
      }
      throw err;
    }
  }
  throw new ProductImageGenerationError("image generation failed after rate-limit retries");
}

/** 输出文件名（基于 index 与版本号）。 */
export function buildOutputFilename(itemCode: string, index: number, version: number): string {
  const safe = itemCode.replace(/[<>:"/\\|?*]/g, "_").slice(0, 80) || "item";
  return `${safe}/${index}-v${version}.png`;
}

export function joinOutputPath(outputRoot: string, filename: string): string {
  return path.join(outputRoot, filename);
}
