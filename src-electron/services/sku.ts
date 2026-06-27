/**
 * SKU 同步服务 —— 移植自 services.py 的 SKU 相关函数。
 */

import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb } from "../db";
import { accounts, products, type Product } from "../db/schema";
import { getConfig } from "../config";
import { firstString } from "../lib/util";
import { isSingleProduct, readImageUrls } from "./serialization";
import {
  fetchAnonymousProductVariantSummary,
  makeAnonymousProductWorkerClient,
} from "./syncHelpers";
import type { JobProgress } from "./jobs";

function applyAnonymousProductSummary(product: Product, summary: Record<string, unknown>): void {
  const db = getDb();
  const newPid = firstString(summary, "productId", "product_id", "id");
  const newName = firstString(summary, "productName", "product_name", "name");
  const variants = summary.variants;
  let skuInfoJson = product.skuInfoJson;
  if (Array.isArray(variants)) {
    const extracted = extractSkuInfoFromAnonymousSummary(summary);
    if (extracted.length) skuInfoJson = JSON.stringify(extracted);
  }
  db.update(products)
    .set({
      productId: newPid || product.productId || null,
      productName: newName || product.productName || null,
      skuInfoJson,
    })
    .where(eq(products.id, product.id))
    .run();
}

function extractSkuInfoFromAnonymousSummary(summary: Record<string, unknown>): unknown[] {
  const variants = summary.variants;
  if (!Array.isArray(variants)) return [];
  const out: unknown[] = [];
  variants.forEach((variant, index) => {
    if (!variant || typeof variant !== "object") return;
    const v = variant as Record<string, unknown>;
    const name = firstString(v, "title", "name", "skuName", "sku_name");
    const itemCode = firstString(v, "itemCode", "item_code", "sku");
    const productId = firstString(v, "productId", "product_id", "id");
    const imagesRaw = v.imageUrls ?? v.images;
    const images = Array.isArray(imagesRaw) ? imagesRaw.filter((s): s is string => typeof s === "string") : [];
    if (!name && !itemCode && !productId && !images.length) return;
    out.push({ index, name, item_code: itemCode, product_id: productId, image: images.length ? images[0] : "", images });
  });
  return out;
}

export interface SyncResult {
  total: number;
  success: number;
  fail: number;
  errors: string[];
}

/** 同步商品 SKU 信息。 */
export async function syncProductSkuInfo(
  opts: { productIds?: number[]; accountIds?: number[]; progress?: JobProgress } = {},
): Promise<SyncResult> {
  const db = getDb();
  const cfg = getConfig();
  const result: SyncResult = { total: 0, success: 0, fail: 0, errors: [] };

  let query = db
    .select()
    .from(products)
    .innerJoin(accounts, eq(products.accountId, accounts.id))
    .where(eq(accounts.enabled, true));

  // 过滤单 SKU
  const conditions = [];
  if (opts.productIds?.length) conditions.push(inArray(products.id, opts.productIds));
  const candidates = db
    .select()
    .from(products)
    .innerJoin(accounts, eq(products.accountId, accounts.id))
    .where(
      and(
        eq(accounts.enabled, true),
        opts.productIds?.length ? inArray(products.id, opts.productIds!) : eq(products.hidden, false),
      ),
    )
    .orderBy(asc(products.accountId), asc(products.id))
    .all();

  const target = candidates.filter((row) => {
    const raw = safeParse(row.products.rawDetailJson);
    return !isSingleProduct(raw);
  });

  result.total = target.length;
  opts.progress?.addTotal(target.length);

  if (cfg.anonymousProductResolver === "worker") {
    return syncProductSkuInfoWithWorker(target.map((t) => t.products), opts.progress);
  }

  // local resolver
  const concurrency = Math.min(cfg.anonymousProductSkuConcurrency || 5, Math.max(1, target.length));
  for (let i = 0; i < target.length; i += concurrency) {
    const batch = target.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (row) => {
        const product = row.products;
        try {
          const summary = await fetchAnonymousProductVariantSummary(product.itemCode);
          applyAnonymousProductSummary(product, summary);
          result.success++;
          opts.progress?.success(1);
        } catch (err) {
          result.fail++;
          const msg = `${product.itemCode}: ${err}`;
          result.errors.push(msg);
          opts.progress?.fail(1, msg);
        }
      }),
    );
  }
  result.errors = result.errors.slice(0, 20);
  void query;
  void conditions;
  return result;
}

async function syncProductSkuInfoWithWorker(productList: Product[], progress?: JobProgress): Promise<SyncResult> {
  const cfg = getConfig();
  const result: SyncResult = { total: productList.length, success: 0, fail: 0, errors: [] };
  const batchSize = cfg.anonymousProductWorkerBatchSize || 6;
  const workerConcurrency = cfg.anonymousProductWorkerConcurrency || 3;
  const refs = productList.map((p) => ({ id: p.id, itemCode: p.itemCode.trim() }));
  const batches: { id: number; itemCode: string }[][] = [];
  for (let i = 0; i < refs.length; i += batchSize) {
    batches.push(refs.slice(i, i + batchSize));
  }
  const concurrency = Math.min(cfg.anonymousProductWorkerRequestConcurrency || 10, Math.max(1, batches.length));

  for (let i = 0; i < batches.length; i += concurrency) {
    const chunk = batches.slice(i, i + concurrency);
    await Promise.all(
      chunk.map(async (batch) => {
        const itemCodes = Array.from(new Set(batch.map((b) => b.itemCode).filter(Boolean)));
        try {
          const client = makeAnonymousProductWorkerClient();
          const items = await client.getProductVariantsBatchByItemCodes(itemCodes, { concurrency: workerConcurrency });
          const summariesByItem = new Map<string, Record<string, unknown>>();
          for (const item of items) {
            const code = firstString(item, "itemCode", "item_code");
            if (code) {
              const data = (item.data as Record<string, unknown>) ?? item;
              summariesByItem.set(code, data as Record<string, unknown>);
            }
          }
          for (const ref of batch) {
            const summary = summariesByItem.get(ref.itemCode);
            const product = getDb().select().from(products).where(eq(products.id, ref.id)).get();
            if (!product) continue;
            if (summary) {
              applyAnonymousProductSummary(product, summary);
              result.success++;
              progress?.success(1);
            } else {
              result.fail++;
              const msg = `${ref.itemCode}: worker 未返回数据`;
              result.errors.push(msg);
              progress?.fail(1, msg);
            }
          }
        } catch (err) {
          result.fail += batch.length;
          const msg = `worker batch failed: ${err}`;
          result.errors.push(msg);
          progress?.fail(batch.length, msg);
        }
      }),
    );
  }
  result.errors = result.errors.slice(0, 20);
  return result;
}

function safeJsonParse2<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
function safeParse(raw: string | null): Record<string, unknown> {
  return safeJsonParse2<Record<string, unknown>>(raw, {});
}

// 标准化 SKU 信息读取（给 WPS 用）
export function normalizedProductSkuInfo(product: Product): unknown[] {
  const skuInfo = safeJsonParse2<unknown[]>(product.skuInfoJson, []);
  if (Array.isArray(skuInfo) && skuInfo.length) return skuInfo;
  const raw = safeJsonParse2<Record<string, unknown>>(product.rawDetailJson, {});
  return extractSkuInfoFromProductData(raw);
}

function extractSkuInfoFromProductData(productData: Record<string, unknown>): unknown[] {
  for (const key of ["skuInfo", "sku_info", "skuList", "sku_list", "variants", "variantList", "productSkus"]) {
    const v = productData[key];
    if (Array.isArray(v) && v.length) return v as unknown[];
  }
  return [];
}

export { readImageUrls };
