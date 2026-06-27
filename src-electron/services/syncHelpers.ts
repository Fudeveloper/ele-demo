/**
 * 同步辅助：匿名商品解析、wishlist product_ids、resolve item_code。
 * 拆出独立文件以避免循环依赖。
 */

import { getConfig } from "../config";
import {
  GigaB2BAnonymousProductClient,
  GigaB2BAnonymousProductWorkerClient,
  ProductIdCache,
} from "../lib/gigab2b/anonymousProductClient";
import { extractProductIds } from "./webFetch";
import { fetchWebPage } from "./webFetch";
import type { Account } from "../db/schema";
import { ensureAccountCsrf } from "./accounts";
import { fetchProductBaseInfoItemCode } from "./webFetch";
import { parseProductId } from "./webFetch";

let productIdCache: ProductIdCache | null | undefined;
const NO_CACHE = Symbol("no_cache");

function anonymousProductIdCache(): ProductIdCache | null {
  if (productIdCache === undefined) {
    try {
      productIdCache = new ProductIdCache();
    } catch {
      productIdCache = null;
    }
  }
  return productIdCache;
}

function anonymousProductResolver(): "local" | "worker" {
  const cfg = getConfig();
  return cfg.anonymousProductResolver;
}

/** 抓取匿名商品变体摘要。 */
export async function fetchAnonymousProductVariantSummary(itemCode: string): Promise<Record<string, unknown>> {
  const cfg = getConfig();
  const resolver = anonymousProductResolver();
  if (resolver === "worker") {
    return fetchWorkerProductVariantSummary(itemCode);
  }
  // local
  const client = new GigaB2BAnonymousProductClient({
    baseUrl: cfg.gigab2bWebBaseUrl || "https://www.gigab2b.com",
    cache: anonymousProductIdCache(),
    includeVariantItemCodes: cfg.anonymousProductVariantItemCodeEnabled,
  });
  return client.getProductVariantsByItemCode(itemCode) as unknown as Record<string, unknown>;
}

export async function fetchLocalProductVariantSummary(itemCode: string): Promise<Record<string, unknown>> {
  const cfg = getConfig();
  const client = new GigaB2BAnonymousProductClient({
    baseUrl: cfg.gigab2bWebBaseUrl || "https://www.gigab2b.com",
    cache: anonymousProductIdCache(),
    includeVariantItemCodes: cfg.anonymousProductVariantItemCodeEnabled,
  });
  return client.getProductVariantsByItemCode(itemCode) as unknown as Record<string, unknown>;
}

export async function fetchWorkerProductVariantSummary(itemCode: string): Promise<Record<string, unknown>> {
  const cfg = getConfig();
  if (!cfg.anonymousProductWorkerUrl) throw new Error("ANONYMOUS_PRODUCT_WORKER_URL 未配置");
  const client = new GigaB2BAnonymousProductWorkerClient({
    workerUrl: cfg.anonymousProductWorkerUrl,
    token: cfg.anonymousProductWorkerToken,
    timeout: cfg.anonymousProductWorkerTimeout * 1000,
    includeVariantItemCodes: cfg.anonymousProductVariantItemCodeEnabled,
  });
  return client.getProductVariantsByItemCode(itemCode);
}

export function makeAnonymousProductWorkerClient(): GigaB2BAnonymousProductWorkerClient {
  const cfg = getConfig();
  if (!cfg.anonymousProductWorkerUrl) throw new Error("ANONYMOUS_PRODUCT_WORKER_URL 未配置");
  return new GigaB2BAnonymousProductWorkerClient({
    workerUrl: cfg.anonymousProductWorkerUrl,
    token: cfg.anonymousProductWorkerToken,
    timeout: cfg.anonymousProductWorkerTimeout * 1000,
    includeVariantItemCodes: cfg.anonymousProductVariantItemCodeEnabled,
  });
}

/** 抓取账号 wishlist 的 product_id 列表。 */
export async function fetchWishlistProductIds(account: Account, maxPages = 50): Promise<string[]> {
  const baseUrl = account.webBaseUrl || getConfig().gigab2bWebBaseUrl || "https://www.gigab2b.com";
  const basePath = `${baseUrl}/index.php?route=account/wishlist&tab=all&secondTab=all`;
  const ids: string[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = page === 1 ? basePath : `${basePath}&page=${page}`;
    const html = await fetchWebPage({ cookie: account.cookie, url, userAgent: account.userAgent ?? undefined });
    const pageIds = extractProductIds(html);
    const beforeLen = ids.length;
    for (const id of pageIds) {
      if (!ids.includes(id)) ids.push(id);
    }
    if (page > 1 && ids.length === beforeLen) break;
    if (!pageIds.length) break;
  }
  return ids;
}

/** 通过 product_id 解析 item_code。 */
export async function resolveItemCodeByProductId(account: Account, productId: string): Promise<string> {
  await ensureAccountCsrf(account);
  const baseUrl = account.webBaseUrl || getConfig().gigab2bWebBaseUrl || "https://www.gigab2b.com";
  return fetchProductBaseInfoItemCode({
    cookie: account.cookie,
    productId,
    csrfToken: account.csrfToken ?? "",
    baseUrl,
    userAgent: account.userAgent ?? undefined,
  });
}

export function productIdFromSyncInput(inputType: string, value: string): string {
  const v = value.trim();
  if (inputType === "product_id") return /^\d+$/.test(v) ? v : "";
  if (inputType === "url") return parseProductId(value);
  return "";
}

export { NO_CACHE };
