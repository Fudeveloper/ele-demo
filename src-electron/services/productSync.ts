/**
 * 商品同步与 upsert —— 移植自 services.py 的同步相关函数。
 */

import { and, eq, inArray, isNull, ne, not } from "drizzle-orm";
import { getDb } from "../db";
import { accounts, products, type Account, type Product } from "../db/schema";
import { getConfig } from "../config";
import { utcNow, chunks, dedupe, firstString } from "../lib/util";
import {
  GigaB2BClient,
  extractSkusFromProductSkusResponse,
  PRODUCTION_BASE_URL,
} from "../lib/gigab2b/client";
import { GigaB2BApiError, isBusinessAccessRestriction } from "../lib/gigab2b/exceptions";
import { GigaB2BWishlistClient } from "../lib/gigab2b/wishlistClient";
import { ensureImageProcessMap, imageUrlsFromProduct } from "../lib/image/imageMap";
import { isSingleProduct, syncImageCounts } from "./serialization";
import { ensureAccountCsrf, enabledAccounts } from "./accounts";
import {
  fetchAnonymousProductVariantSummary,
  fetchWishlistProductIds,
  resolveItemCodeByProductId,
  productIdFromSyncInput,
} from "./syncHelpers";
import { parseProductId } from "./webFetch";
import { syncProductSkuInfo } from "./sku";
import { syncPriceInventoryCache } from "./priceInventory";
import type { JobProgress } from "./jobs";

const SANITIZE_RE = /[<>:"/\\|?*\x00-\x1f]/g;

export function sanitizeFilenamePart(value: string, def = "item"): string {
  let v = value.replace(/\s+/g, " ").trim();
  v = v.replace(SANITIZE_RE, "_");
  v = v.replace(/^[. ]+|[. ]+$/g, "");
  return v || def;
}

export function makeOpenapiClient(account: Pick<Account, "appid" | "secret" | "openapiBaseUrl">): GigaB2BClient {
  return new GigaB2BClient({
    clientId: account.appid,
    clientSecret: account.secret,
    baseUrl: account.openapiBaseUrl || PRODUCTION_BASE_URL,
  });
}

export async function makeWishlistClient(account: Account): Promise<GigaB2BWishlistClient> {
  await ensureAccountCsrf(account);
  return GigaB2BWishlistClient.fromAccount(account);
}

/** upsert 单个商品。返回 (product, is_new)。不提交（调用方提交）。 */
export async function upsertProduct(
  account: Account,
  productData: Record<string, unknown>,
  opts: { enrichAnonymous?: boolean } = {},
): Promise<[Product, boolean]> {
  const enrichAnonymous = opts.enrichAnonymous ?? true;
  const db = getDb();
  const itemCode = firstString(productData, "sku", "itemCode", "item_code");
  if (!itemCode) throw new Error("商品详情缺少 sku/itemCode");

  const existing = db
    .select()
    .from(products)
    .where(and(eq(products.accountId, account.id), eq(products.itemCode, itemCode)))
    .get();
  const isNew = !existing;

  // 是否重复（其它账号已有同 item_code 且未隐藏）
  const dup = db
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.itemCode, itemCode), ne(products.accountId, account.id), eq(products.hidden, false)))
    .get();
  const isDuplicate = Boolean(dup);

  const single = isSingleProduct(productData);
  let productId = "";
  if (!single) productId = firstString(productData, "productId", "product_id", "id");

  let skuInfo: unknown[] = [];
  if (!single) skuInfo = extractSkuInfoFromProductData(productData);

  // 匿名 SKU 丰富
  if (!single && enrichAnonymous && getConfig().anonymousProductSkuSyncEnabled) {
    try {
      const summary = await fetchAnonymousProductVariantSummary(itemCode);
      const newPid = firstString(summary as Record<string, unknown>, "productId", "product_id", "id");
      if (newPid) productId = newPid;
      const extracted = extractSkuInfoFromAnonymousSummary(summary as Record<string, unknown>);
      if (Array.isArray(extracted) && extracted.length) skuInfo = extracted;
    } catch {
      /* 忽略 */
    }
  }

  const imageUrls = imageUrlsFromProduct(productData);
  const baseMap = existing?.imageProcessMapJson ? JSON.parse(existing.imageProcessMapJson) : null;
  const imageMap = ensureImageProcessMap(baseMap, imageUrls);
  const now = utcNow();

  const productName = firstString(productData, "productName", "product_name", "name");

  if (isNew) {
    const created = db
      .insert(products)
      .values({
        accountId: account.id,
        productId: productId || null,
        itemCode,
        productName: productName || null,
        rawDetailJson: JSON.stringify(productData),
        skuInfoJson: skuInfo.length ? JSON.stringify(skuInfo) : null,
        imageProcessMapJson: JSON.stringify(imageMap),
        hidden: isDuplicate,
        syncedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    syncImageCounts(created);
    db.update(products)
      .set({
        imageCount: created.imageCount,
        processedImageCount: created.processedImageCount,
        processingImageCount: created.processingImageCount,
      })
      .where(eq(products.id, created.id))
      .run();
    return [created, true];
  } else {
    db.update(products)
      .set({
        productId: productId || existing.productId || null,
        productName: productName || existing.productName || null,
        rawDetailJson: JSON.stringify(productData),
        skuInfoJson: existing.skuInfoJson && !isNew ? existing.skuInfoJson : skuInfo.length ? JSON.stringify(skuInfo) : null,
        imageProcessMapJson: JSON.stringify(imageMap),
        syncedAt: now,
        updatedAt: now,
      })
      .where(eq(products.id, existing.id))
      .run();
    const updated = db.select().from(products).where(eq(products.id, existing.id)).get()!;
    syncImageCounts(updated);
    db.update(products)
      .set({
        imageCount: updated.imageCount,
        processedImageCount: updated.processedImageCount,
        processingImageCount: updated.processingImageCount,
      })
      .where(eq(products.id, updated.id))
      .run();
    return [updated, false];
  }
}

// SKU 提取（精简版，覆盖主要字段）
function extractSkuInfoFromProductData(productData: Record<string, unknown>): unknown[] {
  for (const key of ["skuInfo", "sku_info", "skuList", "sku_list", "variants", "variantList", "productSkus"]) {
    const v = productData[key];
    if (Array.isArray(v) && v.length) return skuInfoFromItems(v as Record<string, unknown>[]);
  }
  const comboInfo = productData.comboInfo;
  if (Array.isArray(comboInfo) && comboInfo.length) return skuInfoFromItems(comboInfo as Record<string, unknown>[]);

  const name = firstString(productData, "sku", "itemCode", "item_code", "productName", "product_name", "name");
  const images = imageUrlsFromProduct(productData);
  if (!name && !images.length) return [];
  return [
    {
      index: 0,
      name,
      item_code: firstString(productData, "sku", "itemCode", "item_code"),
      product_id: firstString(productData, "productId", "product_id", "id"),
      image: images.length ? images[0] : "",
      images,
    },
  ];
}

function skuInfoFromItems(items: Record<string, unknown>[]): unknown[] {
  const out: unknown[] = [];
  items.forEach((item, index) => {
    const name = skuDisplayName(item);
    const itemCode = firstString(item, "itemCode", "item_code", "sku");
    const productId = firstString(item, "productId", "product_id", "id");
    const images = imageUrlsFromAny(item);
    if (!name && !itemCode && !productId && !images.length) return;
    out.push({ index, name, item_code: itemCode, product_id: productId, image: images.length ? images[0] : "", images });
  });
  return out;
}

function skuDisplayName(item: Record<string, unknown>): string {
  const direct = firstString(item, "title", "name", "skuName", "sku_name", "optionName", "option_name", "specName", "spec_name", "label");
  if (direct) return direct;
  for (const key of ["option", "options", "attributes", "attributeList", "specs", "specList", "properties", "propertyList"]) {
    const v = item[key];
    if (v) {
      const parts = skuNamePartsFromAny(v);
      if (parts.length) return parts.join(" + ");
    }
  }
  return firstString(item, "sku", "itemCode", "item_code");
}

function skuNamePartsFromAny(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) return value.flatMap(skuNamePartsFromAny);
  if (value && typeof value === "object") return skuNamePartsFromDict(value as Record<string, unknown>);
  return [];
}

function skuNamePartsFromDict(value: Record<string, unknown>): string[] {
  const direct = firstString(value, "value", "valueName", "value_name", "optionValue", "option_value", "name", "title", "label");
  if (direct) return [direct];
  const out: string[] = [];
  for (const key of ["values", "items", "children", "options", "attributes", "specs", "properties"]) {
    const v = value[key];
    if (v) out.push(...skuNamePartsFromAny(v));
  }
  return out;
}

function imageUrlsFromAny(item: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of ["mainImageUrl", "main_image_url", "image", "imageUrl", "image_url", "thumb", "popup"]) {
    const v = item[key];
    if (typeof v === "string" && v.trim()) out.push(v.trim());
  }
  for (const key of ["imageUrls", "image_urls", "images", "imageList", "image_list"]) {
    const v = item[key];
    if (Array.isArray(v)) {
      for (const img of v) {
        if (typeof img === "string" && img.trim()) out.push(img.trim());
        else if (img && typeof img === "object") {
          const o = img as Record<string, unknown>;
          const u = firstString(o, "popup", "thumb", "url", "imageUrl", "image_url");
          if (u) out.push(u);
        }
      }
    }
  }
  return dedupe(out);
}

// 匿名 summary 的 sku 提取
function extractSkuInfoFromAnonymousSummary(summary: Record<string, unknown>): unknown[] {
  const variants = summary.variants;
  if (!Array.isArray(variants)) return [];
  const out: unknown[] = [];
  variants.forEach((variant, index) => {
    if (!variant || typeof variant !== "object") return;
    const v = variant as Record<string, unknown>;
    const name = skuDisplayName(v);
    const itemCode = firstString(v, "itemCode", "item_code", "sku");
    const productId = firstString(v, "productId", "product_id", "id");
    const images = imageUrlsFromAny(v);
    if (!name && !itemCode && !productId && !images.length) return;
    out.push({ index, name, item_code: itemCode, product_id: productId, image: images.length ? images[0] : "", images });
  });
  return out;
}

export { extractSkuInfoFromProductData, skuInfoFromItems, imageUrlsFromAny };

/** 同步单个账号的商品详情（按 item_code 批量）。 */
export async function syncProductDetails(
  account: Account,
  itemCodes: string[],
  opts: {
    productIdsByItemCode?: Record<string, string> | undefined;
    autoFavoritedItemCodes?: string[] | undefined;
  } = {},
): Promise<[number, number]> {
  const clean = itemCodes.map((c) => c.trim()).filter(Boolean);
  if (!clean.length) return [0, 0];
  const client = makeOpenapiClient(account);
  let response: Record<string, unknown>;
  try {
    response = await client.getProductDetailInfo({ skus: clean });
  } catch (err) {
    if (err instanceof GigaB2BApiError && isBusinessAccessRestriction(err)) {
      await favoriteRestrictedProducts(account, clean, opts.productIdsByItemCode);
      if (opts.autoFavoritedItemCodes) {
        for (const c of clean) if (!opts.autoFavoritedItemCodes.includes(c)) opts.autoFavoritedItemCodes.push(c);
      }
      response = await client.getProductDetailInfo({ skus: clean });
    } else {
      throw err;
    }
  }
  const data = response.data;
  if (!Array.isArray(data)) {
    throw new GigaB2BApiError("商品详情接口未返回 data 列表", { response });
  }
  let count = 0;
  let newCount = 0;
  const newProductIds: number[] = [];
  const syncedProductIds: number[] = [];
  for (const productData of data) {
    if (!productData || typeof productData !== "object") continue;
    const [product, created] = await upsertProduct(account, productData as Record<string, unknown>, { enrichAnonymous: false });
    count++;
    if (created) {
      newCount++;
      if (product.id) newProductIds.push(product.id);
    }
    if (product.id) syncedProductIds.push(product.id);
  }
  const skuResolveIds = newProductIds.length ? newProductIds : syncedProductIds;
  if (skuResolveIds.length && getConfig().anonymousProductSkuSyncEnabled) {
    await syncProductSkuInfo({ productIds: skuResolveIds });
  }
  if (syncedProductIds.length) {
    await syncPriceInventoryCache({ productIds: syncedProductIds });
  }
  return [count, newCount];
}

export async function favoriteRestrictedProducts(
  account: Account,
  itemCodes: string[],
  productIdsByItemCode?: Record<string, string>,
): Promise<void> {
  const missing: string[] = [];
  const productIds: string[] = [];
  for (const code of itemCodes) {
    const pid = productIdsByItemCode?.[code];
    if (pid) productIds.push(pid);
    else missing.push(code);
  }
  if (missing.length) {
    throw new Error(
      `商品详情受区域/权限限制，需要先自动收藏，但当前同步输入缺少 product_id；请用商品URL或商品ID同步: ${missing.join(", ")}`,
    );
  }
  const wishlist = await makeWishlistClient(account);
  await wishlist.addProductsToWish(productIds);
}

/** 拉取账号全部 SKU（支持增量 last_updated_after）。 */
export async function fetchAllSkus(
  account: Account,
  pageSize = 200,
  lastUpdatedAfter?: number | null,
): Promise<string[]> {
  const client = makeOpenapiClient(account);
  const allSkus: string[] = [];
  const pad = (n: number) => String(n).padStart(2, "0");
  const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const endTime = new Date();
  // UTC+8 存储，API UTC-8，-16h 偏移
  let startTime: Date | null = null;
  if (lastUpdatedAfter) {
    startTime = new Date((lastUpdatedAfter - 16 * 3600 - 60) * 1000);
  }
  let page = 1;
  for (;;) {
    const kwargs: Record<string, unknown> = { page, pageSize };
    if (startTime) {
      kwargs.queryTimeType = 2;
      kwargs.startTime = fmt(startTime);
      kwargs.endTime = fmt(endTime);
    }
    const response = await client.getProductSkus(kwargs as Parameters<typeof client.getProductSkus>[0]);
    const data = (response.data as Record<string, unknown>) ?? {};
    const records = (data.records as unknown[]) ?? [];
    if (!Array.isArray(records) || !records.length) break;
    const skus = extractSkusFromProductSkusResponse({ data: { records } }, 200);
    allSkus.push(...skus);
    const total = typeof data.total === "number" ? data.total : 0;
    if (total <= page * pageSize) break;
    if (records.length < pageSize) break;
    page++;
  }
  return dedupe(allSkus);
}

/** 同步单个账号的全部商品。 */
export async function syncSingleAccountProducts(
  account: Account,
  pageSize = 200,
  progress?: JobProgress,
): Promise<[number, number]> {
  const lastSynced = account.lastProductSyncedAt;
  const skus = await fetchAllSkus(account, pageSize, lastSynced);
  progress?.addTotal(skus.length);
  let totalSynced = 0;
  let totalNew = 0;
  for (const chunk of chunks(skus, 200)) {
    try {
      const [count, newCount] = await syncProductDetails(account, chunk);
      totalSynced += count;
      totalNew += newCount;
      progress?.success(count);
    } catch (err) {
      progress?.fail(chunk.length, `${account.accountName}: ${err}`);
    }
  }
  const db = getDb();
  db.update(accounts)
    .set({ lastProductSyncedAt: utcNow(), updatedAt: utcNow() })
    .where(eq(accounts.id, account.id))
    .run();
  return [totalSynced, totalNew];
}

/** 同步多个账号的商品。 */
export async function syncAllProductsForAccounts(
  accountIds: number[],
  opts: { full?: boolean; pageSize?: number; progress?: JobProgress } = {},
): Promise<{ totalSynced: number; totalNew: number; durationMs: number }> {
  const startedAt = Date.now();
  const db = getDb();
  if (opts.full) {
    db.update(accounts).set({ lastProductSyncedAt: null }).where(inArray(accounts.id, accountIds)).run();
  }
  const list = db.select().from(accounts).where(inArray(accounts.id, accountIds)).all();
  if (!list.length) return { totalSynced: 0, totalNew: 0, durationMs: 0 };
  let totalSynced = 0;
  let totalNew = 0;
  for (const account of list) {
    if (!account.enabled) continue;
    try {
      const [s, n] = await syncSingleAccountProducts(account, opts.pageSize ?? 200, opts.progress);
      totalSynced += s;
      totalNew += n;
    } catch (err) {
      opts.progress?.fail(0, `${account.accountName}: ${err}`);
    }
  }
  return { totalSynced, totalNew, durationMs: Date.now() - startedAt };
}

export function buildSyncSuccessMessage(itemCode: string, synced: boolean, autoFavorited: boolean): string {
  let msg = synced ? `${itemCode} synced` : `${itemCode} returned no detail`;
  if (autoFavorited) msg += "，已自动收藏";
  return msg;
}

export { fetchWishlistProductIds, resolveItemCodeByProductId };

/** 解析输入为 item_code。 */
export async function resolveItemCode(
  account: Account,
  inputType: string,
  value: string,
): Promise<string> {
  if (inputType === "sku") return value.trim();
  const productId = inputType === "url" ? parseProductId(value) : value.trim();
  if (!productId) throw new Error(`无法从输入解析商品ID: ${value}`);
  return resolveItemCodeByProductId(account, productId);
}

export interface ManualSyncItem {
  account_id: number;
  account_name: string;
  input: string;
  item_code: string;
  success: boolean;
  message: string;
}

export interface ManualSyncResult {
  total: number;
  success: number;
  fail: number;
  items: ManualSyncItem[];
}

/** 手动同步指定商品（按 sku/product_id/url）。 */
export async function syncManualProducts(
  accountIds: number[],
  inputType: string,
  rawValues: string,
): Promise<ManualSyncResult> {
  const accs = enabledAccounts(accountIds);
  const values = splitValues(rawValues);
  const result: ManualSyncResult = { total: accs.length * values.length, success: 0, fail: 0, items: [] };

  for (const account of accs) {
    for (const value of values) {
      const item: ManualSyncItem = {
        account_id: account.id!,
        account_name: account.accountName,
        input: value,
        item_code: "",
        success: false,
        message: "",
      };
      try {
        const productId = productIdFromSyncInput(inputType, value);
        const itemCode = await resolveItemCode(account, inputType, value);
        const autoFavorited: string[] = [];
        const productIdsByItemCode = productId ? { [itemCode]: productId } : undefined;
        const [count] = await syncProductDetails(account, [itemCode], {
          productIdsByItemCode,
          autoFavoritedItemCodes: autoFavorited,
        });
        item.item_code = itemCode;
        item.success = true;
        item.message = buildSyncSuccessMessage(itemCode, count > 0, autoFavorited.includes(itemCode));
        result.success++;
      } catch (err) {
        result.fail++;
        item.message = String((err as Error).message ?? err);
      }
      result.items.push(item);
    }
  }
  return result;
}

function splitValues(raw: string): string[] {
  const parts = raw.split(/[\s,，]+/).map((s) => s.trim()).filter(Boolean);
  return Array.from(new Set(parts));
}

// 显式标记未使用的导入以避免 lint 报错
void and;
void isNull;
void not;
