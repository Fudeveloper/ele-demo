/**
 * 图片处理状态机 —— 移植自 `gigab2b_web/image_map.py`。
 * 纯函数，操作 image_process_map_json 文档。
 */

import { withGigaOssSize } from "../storage/oss";
import { utcNowStr } from "../util";

export const VALID_STATUSES = new Set([
  "pending",
  "processing",
  "generated",
  "approved",
  "rejected",
  "failed",
]);

export interface ImageCandidate {
  path: string;
  created_at: string;
}

export interface ImageProcessItem {
  index: number;
  original_url: string;
  candidates: ImageCandidate[];
  selected_path: string;
  status: string;
  error: string;
  started_at: string;
}

export interface ImageProcessMap {
  version: number;
  items: ImageProcessItem[];
}

/** 从商品原始数据提取图片 URL（mainImageUrl + imageUrls），统一为 900x900。 */
export function imageUrlsFromProduct(product: Record<string, unknown>): string[] {
  const result: string[] = [];
  const mainImage = product.mainImageUrl;
  if (typeof mainImage === "string" && mainImage.trim()) result.push(mainImage.trim());
  const urls = product.imageUrls;
  if (Array.isArray(urls)) {
    for (const item of urls) {
      if (typeof item === "string" && item.trim()) result.push(item.trim());
    }
  }
  const normalized = result.map((u) => withGigaOssSize(u));
  return Array.from(new Set(normalized));
}

export function ensureImageProcessMap(
  existing: ImageProcessMap | null | undefined,
  imageUrls: string[],
): ImageProcessMap {
  const result: ImageProcessMap = { version: 1, items: [] };
  const existingItems = new Map<number, ImageProcessItem>();
  if (existing && Array.isArray(existing.items)) {
    for (const item of existing.items) {
      if (item && typeof item.index === "number") existingItems.set(item.index, item);
    }
  }

  imageUrls.forEach((originalUrl, index) => {
    const old = existingItems.get(index) ?? ({} as Partial<ImageProcessItem>);
    const item: ImageProcessItem = {
      index,
      original_url: originalUrl,
      candidates: candidateList(old?.candidates),
      selected_path: stringOrEmpty(old?.selected_path),
      status: statusOrDefault(old?.status),
      error: stringOrEmpty(old?.error),
      started_at: stringOrEmpty(old?.started_at),
    };
    if ((old as ImageProcessItem)?.original_url !== originalUrl && !item.candidates.length) {
      item.selected_path = "";
      item.status = "pending";
      item.error = "";
    }
    result.items.push(item);
  });
  return result;
}

export function appendCandidate(
  imageMap: ImageProcessMap,
  opts: { index: number; originalUrl: string; path: string },
): ImageProcessMap {
  const item = getOrCreateItem(imageMap, opts.index, opts.originalUrl);
  item.candidates.push({ path: normalizePath(opts.path), created_at: utcNowStr() });
  item.selected_path = normalizePath(opts.path);
  item.status = "generated";
  item.error = "";
  return imageMap;
}

export function markFailed(
  imageMap: ImageProcessMap,
  opts: { index: number; originalUrl: string; error: string },
): ImageProcessMap {
  const item = getOrCreateItem(imageMap, opts.index, opts.originalUrl);
  item.status = "failed";
  item.error = opts.error.slice(0, 500);
  return imageMap;
}

export function markProcessing(
  imageMap: ImageProcessMap,
  opts: { index: number; originalUrl: string },
): ImageProcessMap {
  const item = getOrCreateItem(imageMap, opts.index, opts.originalUrl);
  item.status = "processing";
  item.error = "";
  item.started_at = utcNowStr();
  return imageMap;
}

export function approveCandidate(
  imageMap: ImageProcessMap,
  opts: { index: number; selectedPath?: string | undefined },
): ImageProcessMap {
  const item = findItem(imageMap, opts.index);
  if (!item) throw new Error(`image index ${opts.index} does not exist`);
  const candidates = candidateList(item.candidates);
  const targetPath = selectedCandidatePath(item, candidates, opts.selectedPath);
  const selected = candidates.filter((c) => normalizePath(c.path) === targetPath);
  if (!selected.length) throw new Error(`image candidate does not exist: ${targetPath}`);
  item.selected_path = selected[0]!.path;
  item.candidates = selected.slice(0, 1);
  item.status = "approved";
  item.error = "";
  return imageMap;
}

export function unselectedCandidatePaths(
  imageMap: ImageProcessMap,
  opts: { index: number; selectedPath?: string | undefined },
): string[] {
  const item = findItem(imageMap, opts.index);
  if (!item) throw new Error(`image index ${opts.index} does not exist`);
  const candidates = candidateList(item.candidates);
  const targetPath = selectedCandidatePath(item, candidates, opts.selectedPath);
  return candidates.filter((c) => normalizePath(c.path) !== targetPath).map((c) => c.path);
}

export function removeCandidate(
  imageMap: ImageProcessMap,
  opts: { index: number; selectedPath?: string | undefined },
): string {
  const item = findItem(imageMap, opts.index);
  if (!item) throw new Error(`image index ${opts.index} does not exist`);
  const candidates = candidateList(item.candidates);
  const targetPath = normalizePath(
    opts.selectedPath ||
      stringOrEmpty(item.selected_path) ||
      (candidates.length ? candidates[candidates.length - 1]!.path : ""),
  );
  if (!targetPath) throw new Error(`image index ${opts.index} has no generated candidate`);

  const remaining = candidates.filter((c) => normalizePath(c.path) !== targetPath);
  if (remaining.length === candidates.length) {
    throw new Error(`image candidate does not exist: ${targetPath}`);
  }
  item.candidates = remaining;
  item.selected_path = remaining.length ? remaining[remaining.length - 1]!.path : "";
  item.status = remaining.length ? "generated" : "pending";
  item.error = "";
  return targetPath;
}

export function rejectImage(
  imageMap: ImageProcessMap,
  opts: { index: number; selectedPath?: string | undefined },
): ImageProcessMap {
  removeCandidate(imageMap, opts);
  return imageMap;
}

export function nextCandidateVersion(imageMap: ImageProcessMap, opts: { index: number }): number {
  const item = findItem(imageMap, opts.index);
  if (!item) return 1;
  const candidates = candidateList(item.candidates);
  const versions = candidates
    .map((c) => candidatePathVersion(c.path, opts.index))
    .filter((v): v is number => v !== null);
  const nextByCount = candidates.length + 1;
  const nextByVersion = (versions.length ? Math.max(...versions) : 0) + 1;
  return Math.max(nextByCount, nextByVersion);
}

/** ---- 内部工具 ---- */

function getOrCreateItem(
  imageMap: ImageProcessMap,
  index: number,
  originalUrl: string,
): ImageProcessItem {
  if (!imageMap.version) imageMap.version = 1;
  if (!Array.isArray(imageMap.items)) imageMap.items = [];
  const existing = findItem(imageMap, index);
  if (existing) return existing;
  const item: ImageProcessItem = {
    index,
    original_url: originalUrl,
    candidates: [],
    selected_path: "",
    status: "pending",
    error: "",
    started_at: "",
  };
  imageMap.items.push(item);
  imageMap.items.sort((a, b) => a.index - b.index);
  return item;
}

export function findItem(imageMap: ImageProcessMap, index: number): ImageProcessItem | null {
  for (const item of imageMap.items ?? []) {
    if (item && item.index === index) return item;
  }
  return null;
}

function selectedCandidatePath(
  item: ImageProcessItem,
  candidates: ImageCandidate[],
  selectedPath?: string | undefined,
): string {
  const target = normalizePath(
    selectedPath ||
      stringOrEmpty(item.selected_path) ||
      (candidates.length ? candidates[candidates.length - 1]!.path : ""),
  );
  if (!target) throw new Error(`image index ${item.index} has no generated candidate`);
  if (!candidates.length) throw new Error(`image index ${item.index} has no generated candidate`);
  return target;
}

function candidateList(value: unknown): ImageCandidate[] {
  const candidates: ImageCandidate[] = [];
  if (!Array.isArray(value)) return candidates;
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const p = (item as Record<string, unknown>).path;
    if (typeof p !== "string" || !p.trim()) continue;
    const createdAt = (item as Record<string, unknown>).created_at;
    candidates.push({
      path: p.trim().replace(/\\/g, "/"),
      created_at: typeof createdAt === "string" ? createdAt : "",
    });
  }
  return candidates;
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizePath(value: string): string {
  return String(value).trim().replace(/\\/g, "/");
}

function candidatePathVersion(p: string, index: number): number | null {
  const m = new RegExp(`(?:^|/)${index}-v(\\d+)\\.[^./\\\\]+$`).exec(normalizePath(p));
  if (!m || !m[1]) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isNaN(n) ? null : n;
}

function statusOrDefault(value: unknown): string {
  return typeof value === "string" && VALID_STATUSES.has(value) ? value : "pending";
}

/** 统计 image_map 的 processed/processing 数量。 */
export function countImageStatuses(map: ImageProcessMap): {
  total: number;
  processed: number;
  processing: number;
} {
  const items = map?.items ?? [];
  let processed = 0;
  let processing = 0;
  for (const item of items) {
    if (item.status === "approved" || item.status === "generated") processed++;
    if (item.status === "processing") processing++;
  }
  return { total: items.length, processed, processing };
}
