/**
 * 价格/库存缓存服务 —— 移植自 services.py 的相关函数。
 */

import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb } from "../db";
import { accounts, products, type Account, type Product } from "../db/schema";
import { getConfig } from "../config";
import { utcNow, chunks, firstString } from "../lib/util";
import { makeOpenapiClient } from "./productSync";
import { isLocalProduct, cachedPriceInventory, type PriceInventoryData } from "./serialization";
import { PRICE_INVENTORY_SYNC_CHUNK_SIZE } from "./serialization";
import type { JobProgress } from "./jobs";

export interface PriceInventoryResult {
  total: number;
  success: number;
  fail: number;
  errors: string[];
}

function responseItems(response: Record<string, unknown>): unknown[] {
  const data = response.data;
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    for (const key of ["records", "items", "list"]) {
      if (Array.isArray(d[key])) return d[key] as unknown[];
    }
  }
  return [];
}

function normalizePriceItem(item: Record<string, unknown>): Record<string, unknown> | null {
  const result: Record<string, unknown> = {};
  const currency = String(item.currency ?? "").trim();
  const suffix = currency ? ` ${currency}` : "";
  if (item.price !== undefined && item.price !== null) {
    result.price = `${item.price}${suffix}`;
  }
  if (item.shippingFee !== undefined && item.shippingFee !== null) {
    result.shippingFee = `${item.shippingFee}${suffix}`;
  }
  if (
    item.price !== undefined &&
    item.price !== null &&
    item.shippingFee !== undefined &&
    item.shippingFee !== null
  ) {
    const total = (Number(item.price) + Number(item.shippingFee)).toFixed(2);
    result.totalPrice = `${total}${suffix}`;
  }
  return Object.keys(result).length ? result : null;
}

function normalizeInventoryItem(item: Record<string, unknown>): Record<string, unknown> | null {
  const sellerInfo = item.sellerInventoryInfo;
  if (!sellerInfo || typeof sellerInfo !== "object") return null;
  const available = (sellerInfo as Record<string, unknown>).sellerAvailableInventory;
  if (available === undefined || available === null) return null;
  return { sellerInventoryInfo: { sellerAvailableInventory: available } };
}

async function fetchProductPriceMap(account: Account, itemCodes: string[]): Promise<Map<string, Record<string, unknown>>> {
  const client = makeOpenapiClient(account);
  const resp = await client.getProductPrice(itemCodes);
  const items = responseItems(resp) as Record<string, unknown>[];
  const map = new Map<string, Record<string, unknown>>();
  items.forEach((item, idx) => {
    const code = firstString(item, "sku", "itemCode", "item_code") || itemCodes[idx] || "";
    const priceData = normalizePriceItem(item);
    if (code && priceData) map.set(code, priceData);
  });
  return map;
}

async function fetchProductInventoryMap(account: Account, itemCodes: string[]): Promise<Map<string, Record<string, unknown>>> {
  const client = makeOpenapiClient(account);
  const resp = await client.getInventoryQuantity(itemCodes);
  const items = responseItems(resp) as Record<string, unknown>[];
  const map = new Map<string, Record<string, unknown>>();
  items.forEach((item, idx) => {
    const code = firstString(item, "sku", "itemCode", "item_code") || itemCodes[idx] || "";
    const invData = normalizeInventoryItem(item);
    if (code && invData) map.set(code, invData);
  });
  return map;
}

function setPriceInventoryCache(
  product: Product,
  opts: { priceData?: Record<string, unknown> | null | undefined; inventoryData?: Record<string, unknown> | null | undefined; error?: string | undefined },
): void {
  const db = getDb();
  const cached = cachedPriceInventory(product.priceInventoryJson);
  const priceData = opts.priceData !== undefined ? opts.priceData : cached.price;
  const inventoryData = opts.inventoryData !== undefined ? opts.inventoryData : cached.inventory;
  const error = (opts.error ?? "").slice(0, 512) || "";
  db.update(products)
    .set({
      priceInventoryJson: JSON.stringify({ price: priceData ?? null, inventory: inventoryData ?? null }),
      priceInventorySyncedAt: utcNow(),
      priceInventoryError: error || null,
      updatedAt: utcNow(),
    })
    .where(eq(products.id, product.id))
    .run();
}

function markPriceInventoryCacheFailed(productsList: Product[], error: string): void {
  for (const p of productsList) {
    setPriceInventoryCache(p, { error: `${error}，可能是已取消收藏` });
  }
}

async function syncPriceInventoryCacheChunk(account: Account, productList: Product[]): Promise<PriceInventoryResult> {
  const db = getDb();
  const result: PriceInventoryResult = { total: productList.length, success: 0, fail: 0, errors: [] };
  const needFetch: Product[] = [];
  for (const product of productList) {
    const cached = cachedPriceInventory(product.priceInventoryJson);
    if (cached.price && cached.inventory && !product.priceInventoryError) {
      result.success++;
    } else {
      needFetch.push(product);
    }
  }
  if (!needFetch.length) return result;

  const itemCodes = needFetch.map((p) => p.itemCode.trim()).filter(Boolean);

  let priceMap: Map<string, Record<string, unknown>>;
  try {
    priceMap = await fetchProductPriceMap(account, itemCodes);
  } catch (err) {
    markPriceInventoryCacheFailed(needFetch, `价格获取失败: ${err}`);
    result.fail = needFetch.length;
    for (const p of needFetch) result.errors.push(`${p.productName || p.itemCode}: 价格获取失败`);
    return result;
  }

  let inventoryMap: Map<string, Record<string, unknown>>;
  try {
    inventoryMap = await fetchProductInventoryMap(account, itemCodes);
  } catch (err) {
    markPriceInventoryCacheFailed(needFetch, `库存获取失败: ${err}`);
    result.fail = needFetch.length;
    for (const p of needFetch) result.errors.push(`${p.productName || p.itemCode}: 库存获取失败`);
    return result;
  }

  for (const product of needFetch) {
    const code = product.itemCode.trim();
    const priceData = priceMap.get(code) ?? null;
    const inventoryData = inventoryMap.get(code) ?? null;
    if (priceData && inventoryData) {
      setPriceInventoryCache(product, { priceData, inventoryData, error: "" });
      result.success++;
    } else {
      const missing: string[] = [];
      if (!priceData) missing.push("价格");
      if (!inventoryData) missing.push("库存");
      const msg = `${missing.join("/") }接口未返回该 SKU，可能是已取消收藏`;
      setPriceInventoryCache(product, { error: msg });
      result.fail++;
      result.errors.push(`${code}: ${msg}`);
    }
  }
  void db;
  return result;
}

export async function syncPriceInventoryCache(
  opts: { productIds?: number[]; accountIds?: number[]; progress?: JobProgress } = {},
): Promise<PriceInventoryResult> {
  const db = getDb();
  const result: PriceInventoryResult = { total: 0, success: 0, fail: 0, errors: [] };
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
    return !isLocalProduct(raw);
  });

  result.total = target.length;
  opts.progress?.addTotal(target.length);

  // 按账号分组
  const byAccount = new Map<number, Product[]>();
  for (const row of target) {
    const list = byAccount.get(row.products.accountId) ?? [];
    list.push(row.products);
    byAccount.set(row.products.accountId, list);
  }

  for (const [accountId, list] of byAccount) {
    const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
    if (!account) continue;
    for (const chunk of chunks(list, PRICE_INVENTORY_SYNC_CHUNK_SIZE)) {
      try {
        const r = await syncPriceInventoryCacheChunk(account, chunk);
        result.success += r.success;
        result.fail += r.fail;
        result.errors.push(...r.errors);
        opts.progress?.success(r.success);
        opts.progress?.fail(r.fail, r.errors.join("; "));
      } catch (err) {
        result.fail += chunk.length;
        opts.progress?.fail(chunk.length, String(err));
      }
    }
  }
  result.errors = result.errors.slice(0, 20);
  return result;
}

/** 为 WPS 同步刷新单商品价格库存（带缓存回退）。 */
export async function refreshPriceInventoryCacheForCloudDoc(product: Product): Promise<PriceInventoryData> {
  const raw = safeParse(product.rawDetailJson);
  if (isLocalProduct(raw)) return {};
  const cached = cachedPriceInventory(product.priceInventoryJson);
  if (cached.price && cached.inventory && !product.priceInventoryError) return cached;

  const client = makeOpenapiClient(
    await (async () => {
      const db = getDb();
      const acc = db.select().from(accounts).where(eq(accounts.id, product.accountId)).get();
      if (!acc) throw new Error("account not found");
      return acc;
    })(),
  );
  let priceData: Record<string, unknown> | null = null;
  let inventoryData: Record<string, unknown> | null = null;
  try {
    const priceResp = await client.getProductPrice([product.itemCode]);
    const items = responseItems(priceResp) as Record<string, unknown>[];
    if (items.length && items[0]) priceData = normalizePriceItem(items[0]);
  } catch {
    /* 忽略 */
  }
  try {
    const invResp = await client.getInventoryQuantity([product.itemCode]);
    const items = responseItems(invResp) as Record<string, unknown>[];
    if (items.length && items[0]) inventoryData = normalizeInventoryItem(items[0]);
  } catch {
    /* 忽略 */
  }
  const result: PriceInventoryData = {
    price: priceData ?? cached.price,
    inventory: inventoryData ?? cached.inventory,
  };
  if (priceData && inventoryData) {
    setPriceInventoryCache(product, { priceData, inventoryData, error: "" });
  } else {
    const missing: string[] = [];
    if (!priceData) missing.push("价格");
    if (!inventoryData) missing.push("库存");
    setPriceInventoryCache(product, {
      priceData: result.price,
      inventoryData: result.inventory,
      error: `${missing.join("/")}获取失败，已使用缓存，可能是已取消收藏`,
    });
  }
  const out: PriceInventoryData = {};
  if (result.price) out.price = result.price;
  if (result.inventory) out.inventory = result.inventory;
  return out;
}

function safeParse(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}
