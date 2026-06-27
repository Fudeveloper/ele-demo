/**
 * 图片生成编排服务 —— 移植自 services.py 的图片相关编排函数。
 */

import path from "node:path";
import { existsSync, mkdirSync, promises as fs } from "node:fs";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "../db";
import { accounts, products, type Account, type Product } from "../db/schema";
import { getConfig } from "../config";
import { utcNow, formatDuration, chunks } from "../lib/util";
import {
  ensureImageProcessMap,
  imageUrlsFromProduct,
  markProcessing,
  markFailed,
  appendCandidate,
  nextCandidateVersion,
  approveCandidate,
  unselectedCandidatePaths,
  rejectImage,
  removeCandidate,
  countImageStatuses,
  type ImageProcessMap,
} from "../lib/image/imageMap";
import {
  executeImageGenerationTask,
  type ImageGenerationTask,
} from "../lib/image/generationTask";
import { createUploader, isUploaderConfigured } from "../lib/storage/uploader";
import { safeJsonParse } from "../lib/util";
import { sanitizeFilenamePart } from "./productSync";
import type { JobProgress } from "./jobs";

function dbProduct(pid: number): Product | undefined {
  return getDb().select().from(products).where(eq(products.id, pid)).get();
}

function parseImageMap(product: Product): ImageProcessMap {
  return safeJsonParse<ImageProcessMap>(product.imageProcessMapJson, { version: 1, items: [] });
}

function isImageProcessed(item: { status: string; selected_path?: string }): boolean {
  return Boolean(item.selected_path) || ["generated", "approved"].includes(item.status);
}

function isImageProcessing(item: { status: string }): boolean {
  return item.status === "processing";
}

function validUniqueIndices(indices: number[], count: number): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const i of indices) {
    if (i >= 0 && i < count && !seen.has(i)) {
      seen.add(i);
      out.push(i);
    }
  }
  return out;
}

/** 生成图片源 URL（本地图先上传到图床）。 */
export async function imageSourceUrlForGeneration(sourceUrl: string, itemCode = ""): Promise<string> {
  let normalized = sourceUrl.trim();
  if (normalized.startsWith("/api/files/")) normalized = normalized.slice("/api/files/".length);
  const cfg = getConfig();
  if (normalized.startsWith("local-images/")) {
    const filePath = path.resolve(cfg.localImagesRoot, normalized.slice("local-images/".length));
    return uploadToImageHost(filePath, itemCode);
  }
  if (normalized.startsWith("modify-images/")) {
    const filePath = path.resolve(cfg.modifyImagesRoot, normalized.slice("modify-images/".length));
    return uploadToImageHost(filePath, itemCode);
  }
  return sourceUrl;
}

async function uploadToImageHost(filePath: string, itemCode = ""): Promise<string> {
  if (!isUploaderConfigured()) throw new Error("图床未配置");
  const uploader = createUploader();
  return uploader.upload(filePath, { itemCode });
}

/** 公开 URL（本地图先上传）。 */
export async function publicImageUrl(sourceUrl: string, itemCode = ""): Promise<string> {
  if (!sourceUrl.trim()) return "";
  if (/^https?:\/\//.test(sourceUrl)) return sourceUrl;
  return imageSourceUrlForGeneration(sourceUrl, itemCode);
}

/** 构造单图片生成任务。 */
export async function buildTask(
  product: Product,
  sourceUrl: string,
  imageMap: ImageProcessMap,
  index: number,
  opts: { flip?: boolean | null | undefined; apiKey?: string | null | undefined } = {},
): Promise<ImageGenerationTask> {
  const cfg = getConfig();
  const db = getDb();
  const acc = db.select().from(accounts).where(eq(accounts.id, product.accountId)).get();
  if (!acc) throw new Error("account not found");

  const apiKey = opts.apiKey || cfg.imgApiKey;
  if (!apiKey) throw new Error("IMG_API_KEY 未配置");

  const outputRoot = cfg.modifyImagesRoot;
  const safeItemCode = sanitizeFilenamePart(product.itemCode, "item");
  const outputDir = path.join(outputRoot, String(acc.id), safeItemCode);
  mkdirSync(outputDir, { recursive: true });

  const version = nextCandidateVersion(imageMap, { index });
  let versionNum = version;
  let outputPath = path.join(outputDir, `${index}-v${versionNum}.png`);
  while (existsSync(outputPath)) {
    versionNum++;
    outputPath = path.join(outputDir, `${index}-v${versionNum}.png`);
  }
  const storedPath = `modify-images/${acc.id}/${safeItemCode}/${index}-v${versionNum}.png`;
  const generationSourceUrl = await imageSourceUrlForGeneration(sourceUrl, product.itemCode);

  const flip = opts.flip === null ? false : opts.flip === undefined ? !product.disableFlip : opts.flip && !product.disableFlip;

  const [w, h] = parseImageOutputSize(cfg.imageOutputSize);

  return {
    productId: product.id!,
    itemCode: product.itemCode,
    accountId: product.accountId,
    clientId: acc.appid,
    clientSecret: acc.secret,
    openapiBaseUrl: acc.openapiBaseUrl,
    sourceUrl: generationSourceUrl,
    imageIndex: index,
    originalUrl: sourceUrl,
    outputRoot,
    outputPath,
    storedPath,
    apiKey,
    imageApiBaseUrl: cfg.imgApiBaseUrl,
    imageApiModel: cfg.imgApiModel,
    imageApiWireApi: cfg.imgApiWireApi,
    imageApiGroup: cfg.imgApiGroup,
    imageApiStream: cfg.imgApiStream,
    imageApiTimeout: cfg.imgApiTimeout,
    imageApiPollInterval: cfg.imgApiPollInterval,
    outputSize: [w, h],
    disableFlip: product.disableFlip,
    flip,
    imageAnalysisEnabled: cfg.imageAnalysisEnabled,
    imageAnalysisBaseUrl: cfg.imageAnalysisBaseUrl,
    imageAnalysisModel: cfg.imageAnalysisModel,
    imageAnalysisApiKey: cfg.imageAnalysisApiKey,
    imageAnalysisTimeout: cfg.imageAnalysisTimeout,
  };
}

function parseImageOutputSize(size: string): [number, number] {
  const m = /^(\d+)\s*[xX×]\s*(\d+)$/.exec(size.trim());
  if (m) return [Number(m[1]), Number(m[2])];
  return [900, 900];
}

export interface GenerateResult {
  total: number;
  success: number;
  fail: number;
  errors: string[];
  durationMs: number;
}

/** 批量生成图片（主入口）。 */
export async function generateProductImages(
  productIds: number[],
  opts: {
    indicesByProduct?: Record<number, number[]>;
    skipProcessed?: boolean;
    flipSource?: boolean;
    allowProcessingItems?: boolean;
    progress?: JobProgress;
  } = {},
): Promise<GenerateResult> {
  const db = getDb();
  const cfg = getConfig();
  const result: GenerateResult = { total: 0, success: 0, fail: 0, errors: [], durationMs: 0 };
  const startedAt = Date.now();
  const apiKeys = cfg.imgApiKeys.length ? cfg.imgApiKeys : cfg.imgApiKey ? [cfg.imgApiKey] : [];

  const list = db.select().from(products).where(inArray(products.id, productIds)).all();
  const tasks: ImageGenerationTask[] = [];

  // 任务构建
  for (const product of list) {
    const raw = safeJsonParse<Record<string, unknown>>(product.rawDetailJson, {});
    if (opts.skipProcessed && product.manuallyProcessed) continue;
    const imageUrls = imageUrlsFromProduct(raw);
    let imageMap = ensureImageProcessMap(parseImageMap(product), imageUrls);
    const targetIndices = opts.indicesByProduct?.[product.id!]
      ? validUniqueIndices(opts.indicesByProduct[product.id!] ?? [], imageUrls.length)
      : Array.from({ length: imageUrls.length }, (_, i) => i);
    for (const index of targetIndices) {
      const item = imageMap.items.find((it) => it.index === index) ?? { status: "pending", selected_path: "", candidates: [], original_url: imageUrls[index] ?? "", index, error: "", started_at: "" };
      if (opts.skipProcessed && isImageProcessed(item)) continue;
      if (isImageProcessing(item) && !opts.allowProcessingItems) continue;
      if (!isImageProcessing(item)) {
        imageMap = markProcessing(imageMap, { index, originalUrl: imageUrls[index] ?? "" });
      }
      const apiKey = apiKeys.length ? apiKeys[tasks.length % apiKeys.length] : null;
      try {
        const task = await buildTask(product, imageUrls[index] ?? "", imageMap, index, {
          flip: opts.flipSource,
          apiKey,
        });
        tasks.push(task);
      } catch (err) {
        result.errors.push(`${product.itemCode} image ${index}: ${err}`);
      }
    }
    const counts = countImageStatuses(imageMap);
    db.update(products)
      .set({
        imageProcessMapJson: JSON.stringify(imageMap),
        processedImageCount: Math.min(counts.processed, imageUrls.length),
        processingImageCount: Math.min(counts.processing, imageUrls.length),
        updatedAt: utcNow(),
      })
      .where(eq(products.id, product.id!))
      .run();
  }

  result.total = tasks.length;
  opts.progress?.addTotal(tasks.length);
  if (!tasks.length) {
    result.durationMs = Date.now() - startedAt;
    return result;
  }

  // 串行执行（简化）
  for (const task of tasks) {
    const taskResult = await executeImageGenerationTask(task);
    const product = dbProduct(task.productId);
    if (!product) continue;
    const raw = safeJsonParse<Record<string, unknown>>(product.rawDetailJson, {});
    const imageUrls = imageUrlsFromProduct(raw);
    let imageMap = ensureImageProcessMap(parseImageMap(product), imageUrls);
    if (taskResult.success) {
      // 上传到图床（如果配置）
      let storedPath = task.storedPath;
      try {
        if (isUploaderConfigured()) {
          await uploadToImageHost(task.outputPath, task.itemCode);
        }
      } catch {
        /* 上传失败不阻断 */
      }
      imageMap = appendCandidate(imageMap, { index: task.imageIndex, originalUrl: task.originalUrl, path: storedPath });
      const counts = countImageStatuses(imageMap);
      db.update(products)
        .set({
          imageProcessMapJson: JSON.stringify(imageMap),
          processedImageCount: Math.min(counts.processed, imageUrls.length),
          processingImageCount: Math.min(counts.processing, imageUrls.length),
          updatedAt: utcNow(),
        })
        .where(eq(products.id, product.id!))
        .run();
      result.success++;
      opts.progress?.success(1, `${task.itemCode} image ${task.imageIndex} generated in ${formatDuration(taskResult.durationMs / 1000)}`);
    } else {
      imageMap = markFailed(imageMap, { index: task.imageIndex, originalUrl: task.originalUrl, error: taskResult.error });
      const counts = countImageStatuses(imageMap);
      db.update(products)
        .set({
          imageProcessMapJson: JSON.stringify(imageMap),
          processedImageCount: Math.min(counts.processed, imageUrls.length),
          processingImageCount: Math.min(counts.processing, imageUrls.length),
          updatedAt: utcNow(),
        })
        .where(eq(products.id, product.id!))
        .run();
      result.fail++;
      const errMsg = `${task.itemCode} image ${task.imageIndex}: ${taskResult.error}`;
      result.errors.push(errMsg);
      opts.progress?.fail(1, `${taskResult.error} (${formatDuration(taskResult.durationMs / 1000)})`);
    }
  }

  result.durationMs = Date.now() - startedAt;
  return result;
}

/** 审批图片候选。返回 (product, deleted_files)。 */
export async function approveProductImage(
  productId: number,
  opts: { index: number; selectedPath?: string },
): Promise<{ product: Product; deletedFiles: { path: string; file_deleted: boolean; error: string }[] }> {
  const db = getDb();
  const product = db.select().from(products).where(eq(products.id, productId)).get();
  if (!product) throw new Error("product not found");
  const raw = safeJsonParse<Record<string, unknown>>(product.rawDetailJson, {});
  const imageUrls = imageUrlsFromProduct(raw);
  let imageMap = ensureImageProcessMap(parseImageMap(product), imageUrls);

  const removedPaths = unselectedCandidatePaths(imageMap, { index: opts.index, selectedPath: opts.selectedPath });
  imageMap = approveCandidate(imageMap, { index: opts.index, selectedPath: opts.selectedPath });
  const counts = countImageStatuses(imageMap);
  db.update(products)
    .set({
      imageProcessMapJson: JSON.stringify(imageMap),
      processedImageCount: Math.min(counts.processed, imageUrls.length),
      processingImageCount: Math.min(counts.processing, imageUrls.length),
      updatedAt: utcNow(),
    })
    .where(eq(products.id, productId))
    .run();
  const updated = db.select().from(products).where(eq(products.id, productId)).get()!;

  const deletedFiles: { path: string; file_deleted: boolean; error: string }[] = [];
  for (const p of removedPaths) {
    const info: { path: string; file_deleted: boolean; error: string } = { path: p, file_deleted: false, error: "" };
    try {
      info.file_deleted = await deleteGeneratedImageFile(p);
    } catch (err) {
      info.error = String(err);
    }
    deletedFiles.push(info);
  }
  return { product: updated, deletedFiles };
}

export async function rejectProductImage(
  productId: number,
  opts: { index: number; selectedPath?: string },
): Promise<{ product: Product; removedPath: string; fileDeleted: boolean }> {
  const db = getDb();
  const product = db.select().from(products).where(eq(products.id, productId)).get();
  if (!product) throw new Error("product not found");
  const raw = safeJsonParse<Record<string, unknown>>(product.rawDetailJson, {});
  const imageUrls = imageUrlsFromProduct(raw);
  const imageMap = ensureImageProcessMap(parseImageMap(product), imageUrls);
  const rp = removeCandidate(imageMap, { index: opts.index, selectedPath: opts.selectedPath });
  const counts = countImageStatuses(imageMap);
  db.update(products)
    .set({
      imageProcessMapJson: JSON.stringify(imageMap),
      processedImageCount: Math.min(counts.processed, imageUrls.length),
      processingImageCount: Math.min(counts.processing, imageUrls.length),
      updatedAt: utcNow(),
    })
    .where(eq(products.id, productId))
    .run();
  const updated = db.select().from(products).where(eq(products.id, productId)).get()!;
  const fileDeleted = await deleteGeneratedImageFile(rp);
  return { product: updated, removedPath: rp, fileDeleted };
}

async function deleteGeneratedImageFile(storedPath: string): Promise<boolean> {
  const cfg = getConfig();
  const normalized = storedPath.replace(/\\/g, "/");
  if (!normalized.startsWith("modify-images/")) throw new Error(`invalid generated path: ${storedPath}`);
  const filePath = path.resolve(cfg.modifyImagesRoot, normalized.slice("modify-images/".length));
  const root = path.resolve(cfg.modifyImagesRoot);
  if (!filePath.startsWith(root)) throw new Error(`invalid generated path: ${storedPath}`);
  try {
    await fs.unlink(filePath);
    return true;
  } catch {
    return false;
  }
}

void rejectImage;
void chunks;
