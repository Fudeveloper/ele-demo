/**
 * 匿名商品解析客户端 —— 移植自 `gigab2b_openapi/anonymous_product_client.py`。
 *
 * 三类后端：
 *   - GigaB2BAnonymousProductClient：匿名抓取公开站点
 *   - GigaB2BAnonymousProductWorkerClient：Cloudflare Worker 镜像
 *   - ProductIdCache：item_code ↔ product_id 缓存（SQLite）
 */

import { GigaB2BApiError, GigaB2BTransportError } from "./exceptions";
import { httpRequest, HttpTransportError, type HttpResponse } from "../http";
import { getDb } from "../../db";
import { itemCodeProductIdCache } from "../../db/schema";
import { eq, desc } from "drizzle-orm";

export const WEB_BASE_URL = "https://www.gigab2b.com";
export const PRODUCT_SEARCH_ROUTE = "product/search";
export const PRODUCT_DETAIL_ROUTE = "product/product";
export const PRODUCT_LIST_SEARCH_ROUTE = "product/list/search";
export const PRODUCT_LIST_ROUTE = "product/list/list";
export const PRODUCT_BASE_INFOS_ROUTE = "product/info/info/baseInfos";
export const PRODUCT_PRICE_LIST_ROUTE = "product/info/price/list";
export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
export const HTML_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

const CSRF_PATTERNS: RegExp[] = [
  /oriCsrfToken\.init\(\s*['"]X-CSRF-TOKEN['"]\s*,\s*['"]([^'"]+)['"]/,
  /<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)['"]/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']csrf-token["']/i,
];

export interface VariantSummary {
  itemCode: string;
  productId: string;
  productName: string;
  mainImage: string | NormalizedImage;
  imageUrls: string[];
  variants: Record<string, unknown>[];
  priceVisible?: unknown;
  qtyVisible?: unknown;
}

/** 匿名站点抓取客户端。维护一个简单 cookie jar。 */
export class GigaB2BAnonymousProductClient {
  baseUrl: string;
  userAgent: string;
  timeout: number;
  csrfToken = "";
  cache: ProductIdCache | null;
  includeVariantItemCodes: boolean;
  private cookies: Record<string, string> = {};

  constructor(opts: {
    baseUrl?: string;
    userAgent?: string;
    timeout?: number;
    cache?: ProductIdCache | null;
    includeVariantItemCodes?: boolean;
  } = {}) {
    this.baseUrl = (opts.baseUrl ?? WEB_BASE_URL).replace(/\/+$/, "");
    this.userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
    this.timeout = opts.timeout ?? 30000;
    this.cache = opts.cache ?? null;
    this.includeVariantItemCodes = opts.includeVariantItemCodes ?? false;
  }

  async getProductIdByItemCode(itemCode: string): Promise<string> {
    const clean = requireText(itemCode, "item_code");
    const cached = await this.getCachedProductId(clean);
    if (cached) return cached;

    const pageUrl = this.searchPageUrl(clean);
    await this.loadPage(pageUrl);

    const searchResponse = await this.postJson(
      PRODUCT_LIST_SEARCH_ROUTE,
      { search: clean, scene: 1, dimension_type: 1, page: 1, limit: 20 },
      pageUrl,
    );
    const productIds = extractProductIdsFromSearchResponse(searchResponse);
    if (!productIds.length) {
      throw new GigaB2BApiError(`no product found for itemCode ${clean}`, { response: searchResponse });
    }

    const productsResponse = await this.postJson(
      PRODUCT_LIST_ROUTE,
      { product_ids: productIds, with_seller: true, with_wishlist: false, type: "grid" },
      pageUrl,
    );
    const matched = findProductIdByItemCode(productsResponse, clean);
    if (matched) {
      await this.cacheProductId(clean, matched, productsResponse);
      return matched;
    }
    throw new GigaB2BApiError(`search returned products but none matched itemCode ${clean}`, {
      response: productsResponse,
    });
  }

  async getItemCodeByProductId(productId: string | number): Promise<string> {
    const clean = requireText(productId, "product_id");
    const cached = await this.getCachedItemCodeByProductId(clean);
    if (cached) return cached;

    const baseResponse = await this.getBaseInfoResponse(clean);
    const dataDict = responseDataDict(baseResponse);
    const productInfo = dataDict.product_info;
    if (!productInfo || typeof productInfo !== "object") {
      throw new GigaB2BApiError("baseInfos response missing data.product_info", { response: baseResponse });
    }
    const itemCode = readString(productInfo as Record<string, unknown>, "sku", "itemCode", "item_code");
    if (!itemCode) {
      throw new GigaB2BApiError(`baseInfos response missing data.product_info.sku for product_id ${clean}`, {
        response: baseResponse,
      });
    }
    await this.cacheProductId(
      itemCode,
      clean,
      undefined,
      readString(productInfo as Record<string, unknown>, "product_name", "productName", "name"),
    );
    return itemCode;
  }

  async getCachedProductId(itemCode: string): Promise<string> {
    return this.cache ? (await this.cache.get(itemCode)) || "" : "";
  }

  async getCachedItemCodeByProductId(productId: string): Promise<string> {
    return this.cache ? (await this.cache.getItemCodeByProductId(productId)) || "" : "";
  }

  async cacheProductId(
    itemCode: string,
    productId: string,
    productsResponse?: Record<string, unknown>,
    productName = "",
  ): Promise<void> {
    if (!this.cache) return;
    let name = productName;
    if (!name && productsResponse) name = findProductNameByProductId(productsResponse, productId);
    await this.cache.set({ itemCode, productId, productName: name });
  }

  async getProductVariantsByItemCode(itemCode: string): Promise<VariantSummary> {
    const clean = requireText(itemCode, "item_code");
    const productId = await this.getProductIdByItemCode(clean);
    return this.getProductVariants(productId, clean);
  }

  async getProductVariants(productId: string | number, itemCode = ""): Promise<VariantSummary> {
    const clean = requireText(productId, "product_id");
    const pageUrl = this.productPageUrl(clean);
    await this.loadPage(pageUrl);

    const baseResponse = await this.getJson(PRODUCT_BASE_INFOS_ROUTE, { product_id: clean }, pageUrl);
    const priceResponse = await this.getJson(PRODUCT_PRICE_LIST_ROUTE, { product_id: clean }, pageUrl);
    const summary = buildProductVariantSummary({
      productId: clean,
      baseResponse,
      priceResponse,
      itemCode,
    });
    if (this.includeVariantItemCodes) await this.enrichVariantItemCodes(summary);
    return summary;
  }

  private async enrichVariantItemCodes(summary: VariantSummary): Promise<void> {
    const variants = summary.variants;
    if (!Array.isArray(variants)) return;
    const productIdToItemCode: Record<string, string> = {};
    const summaryProductId = readString(summary as unknown as Record<string, unknown>, "productId", "product_id", "id");
    if (summaryProductId) {
      productIdToItemCode[summaryProductId] = String((summary as unknown as Record<string, unknown>).itemCode ?? "").trim();
    }
    for (const variant of variants) {
      const v = variant as Record<string, unknown>;
      if (readString(v, "itemCode", "item_code", "sku")) continue;
      const variantProductId = readString(v, "productId", "product_id", "id");
      if (!variantProductId) continue;
      if (!(variantProductId in productIdToItemCode)) {
        productIdToItemCode[variantProductId] = await this.getItemCodeByProductId(variantProductId);
      }
      const code = productIdToItemCode[variantProductId] || "";
      if (code) v.itemCode = code;
    }
  }

  async getBaseInfoResponse(productId: string): Promise<Record<string, unknown>> {
    const pageUrl = this.productPageUrl(productId);
    await this.loadPage(pageUrl);
    return this.getJson(PRODUCT_BASE_INFOS_ROUTE, { product_id: productId }, pageUrl);
  }

  searchPageUrl(itemCode: string): string {
    return `${this.baseUrl}/index.php?route=${PRODUCT_SEARCH_ROUTE}&search=${encodeURIComponent(itemCode)}`;
  }

  productPageUrl(productId: string): string {
    return `${this.baseUrl}/index.php?route=${PRODUCT_DETAIL_ROUTE}&product_id=${encodeURIComponent(productId)}`;
  }

  routeUrl(route: string): string {
    return `${this.baseUrl}/index.php?route=${encodeURIComponent(route)}`;
  }

  private async loadPage(url: string): Promise<string> {
    let resp: HttpResponse;
    try {
      resp = await httpRequest(url, {
        headers: { ...this.browserHeaders(), Accept: HTML_ACCEPT },
        timeoutMs: this.timeout,
      });
    } catch (err) {
      throw new GigaB2BTransportError(err instanceof HttpTransportError ? err.message : String(err));
    }
    if (!resp.ok) throw new GigaB2BTransportError(`load page failed: ${resp.status} ${url}`);
    this.absorbCookies(resp.headers);
    const token = extractCsrfToken(resp.text);
    if (token) this.csrfToken = token;
    return resp.text;
  }

  private async getJson(
    route: string,
    params: Record<string, unknown>,
    referer: string,
  ): Promise<Record<string, unknown>> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
    const url = `${this.routeUrl(route)}&${qs.toString()}`.replace("?&", "?");
    let resp: HttpResponse;
    try {
      resp = await httpRequest(url, {
        headers: this.ajaxHeaders(referer),
        timeoutMs: this.timeout,
      });
    } catch (err) {
      if (err instanceof HttpTransportError) throw new GigaB2BTransportError(err.message);
      throw new GigaB2BTransportError(String(err));
    }
    this.absorbCookies(resp.headers);
    return parseSuccessJson(resp);
  }

  private async postJson(
    route: string,
    payload: Record<string, unknown>,
    referer: string,
  ): Promise<Record<string, unknown>> {
    let resp: HttpResponse;
    try {
      resp = await httpRequest(this.routeUrl(route), {
        method: "POST",
        headers: this.ajaxHeaders(referer),
        body: JSON.stringify(payload),
        timeoutMs: this.timeout,
      });
    } catch (err) {
      if (err instanceof HttpTransportError) throw new GigaB2BTransportError(err.message);
      throw new GigaB2BTransportError(String(err));
    }
    this.absorbCookies(resp.headers);
    return parseSuccessJson(resp);
  }

  private ajaxHeaders(referer: string): Record<string, string> {
    const headers: Record<string, string> = {
      ...this.browserHeaders(),
      Accept: "application/json, text/plain, */*",
      "Ori-Status-In-Response": "code",
      Referer: referer,
      "X-Requested-With": "XMLHttpRequest, XMLHttpRequest",
      "Content-Type": "application/json",
    };
    if (this.csrfToken) headers["X-CSRF-TOKEN"] = this.csrfToken;
    return headers;
  }

  private browserHeaders(): Record<string, string> {
    return {
      "User-Agent": this.userAgent,
      "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
      Cookie: this.cookieHeader(),
    };
  }

  private cookieHeader(): string {
    return Object.entries(this.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }

  private absorbCookies(headers: Headers): void {
    const setCookies = headers.getSetCookie?.() ?? [];
    for (const sc of setCookies) {
      const pair = sc.split(";", 1)[0] ?? "";
      const eq = pair.indexOf("=");
      if (eq > 0) {
        const k = pair.slice(0, eq).trim();
        const v = pair.slice(eq + 1).trim();
        if (k) this.cookies[k] = v;
      }
    }
  }
}

/** SQLite 实现的 item_code/product_id 缓存。 */
export class ProductIdCache {
  async get(itemCode: string): Promise<string> {
    const clean = requireText(itemCode, "item_code");
    const row = getDb()
      .select({ productId: itemCodeProductIdCache.productId })
      .from(itemCodeProductIdCache)
      .where(eq(itemCodeProductIdCache.itemCode, clean))
      .get();
    return (row?.productId ?? "").trim();
  }

  async getItemCodeByProductId(productId: string): Promise<string> {
    const clean = requireText(productId, "product_id");
    const row = getDb()
      .select({ itemCode: itemCodeProductIdCache.itemCode })
      .from(itemCodeProductIdCache)
      .where(eq(itemCodeProductIdCache.productId, clean))
      .orderBy(desc(itemCodeProductIdCache.updatedAt), desc(itemCodeProductIdCache.id))
      .get();
    return (row?.itemCode ?? "").trim();
  }

  async set(opts: { itemCode: string; productId: string; productName?: string }): Promise<void> {
    const cleanItem = requireText(opts.itemCode, "item_code");
    const cleanProduct = requireText(opts.productId, "product_id");
    const name = (opts.productName ?? "").trim();
    const now = Math.floor(Date.now() / 1000);
    getDb()
      .insert(itemCodeProductIdCache)
      .values({
        itemCode: cleanItem,
        productId: cleanProduct,
        productName: name,
        source: "anonymous_product_search",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: itemCodeProductIdCache.itemCode,
        set: {
          productId: cleanProduct,
          productName: name,
          source: "anonymous_product_search",
          updatedAt: now,
        },
      })
      .run();
  }
}

/** Cloudflare Worker 匿名解析客户端。 */
export class GigaB2BAnonymousProductWorkerClient {
  workerUrl: string;
  token: string;
  timeout: number;
  includeVariantItemCodes: boolean;

  constructor(opts: { workerUrl: string; token?: string; timeout?: number; includeVariantItemCodes?: boolean }) {
    const clean = (opts.workerUrl ?? "").replace(/\/+$/, "");
    if (!clean) throw new Error("worker_url is required");
    this.workerUrl = clean;
    this.token = (opts.token ?? "").trim();
    this.timeout = opts.timeout ?? 30000;
    this.includeVariantItemCodes = opts.includeVariantItemCodes ?? false;
  }

  async getProductIdByItemCode(itemCode: string): Promise<string> {
    const data = await this.get("/product-id", { itemCode: requireText(itemCode, "item_code") });
    return readString(data, "productId", "product_id", "id");
  }

  async getItemCodeByProductId(productId: string | number): Promise<string> {
    const data = await this.get("/item-code", { productId: requireText(productId, "product_id") });
    return readString(data, "itemCode", "item_code", "sku");
  }

  async getProductVariantsByItemCode(itemCode: string): Promise<Record<string, unknown>> {
    const params: Record<string, unknown> = { itemCode: requireText(itemCode, "item_code") };
    if (this.includeVariantItemCodes) params.includeVariantItemCodes = true;
    return this.get("/product", params);
  }

  async getProductVariants(productId: string | number, itemCode = ""): Promise<Record<string, unknown>> {
    const params: Record<string, unknown> = { productId: requireText(productId, "product_id") };
    if (itemCode.trim()) params.itemCode = itemCode.trim();
    if (this.includeVariantItemCodes) params.includeVariantItemCodes = true;
    return this.get("/detail", params);
  }

  async getProductVariantsBatchByItemCodes(
    itemCodes: string[],
    opts: { concurrency?: number } = {},
  ): Promise<Record<string, unknown>[]> {
    const clean = itemCodes.map((c) => requireText(c, "item_code")).filter(Boolean);
    if (!clean.length) return [];
    const payload: Record<string, unknown> = { itemCodes: clean };
    if (opts.concurrency !== undefined) payload.concurrency = opts.concurrency;
    if (this.includeVariantItemCodes) payload.includeVariantItemCodes = true;
    const data = await this.post("/batch", payload);
    const items = (data as Record<string, unknown>).items;
    return Array.isArray(items) ? (items as Record<string, unknown>[]) : [];
  }

  headers(): Record<string, string> {
    const h: Record<string, string> = { Accept: "application/json" };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  private async get(path: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
    const url = `${this.workerUrl}${path}?${qs.toString()}`;
    let resp: HttpResponse;
    try {
      resp = await httpRequest(url, { headers: this.headers(), timeoutMs: this.timeout });
    } catch (err) {
      if (err instanceof HttpTransportError) throw new GigaB2BTransportError(err.message);
      throw new GigaB2BTransportError(String(err));
    }
    return parseWorkerJson(resp);
  }

  private async post(path: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    let resp: HttpResponse;
    try {
      resp = await httpRequest(`${this.workerUrl}${path}`, {
        method: "POST",
        headers: { ...this.headers(), "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        timeoutMs: this.timeout,
      });
    } catch (err) {
      if (err instanceof HttpTransportError) throw new GigaB2BTransportError(err.message);
      throw new GigaB2BTransportError(String(err));
    }
    return parseWorkerJson(resp);
  }
}

/** ---- 工具函数 ---- */

export function buildProductVariantSummary(opts: {
  productId: string;
  baseResponse: Record<string, unknown>;
  priceResponse: Record<string, unknown>;
  itemCode?: string;
}): VariantSummary {
  const { productId, baseResponse, priceResponse, itemCode = "" } = opts;
  const dataDict = responseDataDict(baseResponse);
  const productInfo = dataDict.product_info;
  if (!productInfo || typeof productInfo !== "object") {
    throw new GigaB2BApiError("baseInfos response missing data.product_info", { response: baseResponse });
  }
  const info = productInfo as Record<string, unknown>;
  const resolvedItemCode = itemCode.trim() || readString(info, "sku");
  const productName = readString(info, "product_name");
  const baseImages = normalizeImageItems(info.image_list);
  const mainImage = normalizeImageItem(info.main_image);
  const priceData = responseDataDict(priceResponse);
  let variants = extractVariantsFromPriceResponse(priceResponse);
  if (!variants.length) {
    variants = [
      {
        productId,
        itemCode: resolvedItemCode,
        title: productName,
        isSelected: true,
        isHaveAvailableStock: null,
        images: baseImages,
        imageUrls: baseImages.map((img) => img.popup || img.thumb),
      },
    ];
  }
  return {
    itemCode: resolvedItemCode,
    productId,
    productName,
    mainImage,
    imageUrls: baseImages.map((img) => img.popup || img.thumb),
    variants,
    priceVisible: priceData.price_visible,
    qtyVisible: priceData.qty_visible,
  };
}

export function extractProductIdsFromSearchResponse(response: Record<string, unknown>): string[] {
  const data = responseDataDict(response);
  const values = data.product_list;
  if (!Array.isArray(values)) return [];
  const result: string[] = [];
  for (const value of values) {
    const text = String(value).trim();
    if (text) result.push(text);
  }
  return result;
}

export function findProductIdByItemCode(response: Record<string, unknown>, itemCode: string): string {
  const clean = itemCode.trim().toUpperCase();
  const data = response.data;
  if (!Array.isArray(data)) return "";
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    let product = (item as Record<string, unknown>).product;
    if (!product || typeof product !== "object") product = item;
    const sku = readString(product as Record<string, unknown>, "sku", "itemCode", "item_code").toUpperCase();
    if (sku !== clean) continue;
    const productId = readString(product as Record<string, unknown>, "id", "product_id", "productId");
    if (productId) return productId;
  }
  return "";
}

export function findProductNameByProductId(response: Record<string, unknown>, productId: string): string {
  const clean = productId.trim();
  const data = response.data;
  if (!Array.isArray(data)) return "";
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    let product = (item as Record<string, unknown>).product;
    if (!product || typeof product !== "object") product = item;
    const currentId = readString(product as Record<string, unknown>, "id", "product_id", "productId");
    if (currentId !== clean) continue;
    return readString(product as Record<string, unknown>, "name", "product_name", "productName");
  }
  return "";
}

export function extractVariantsFromPriceResponse(response: Record<string, unknown>): Record<string, unknown>[] {
  const data = responseDataDict(response);
  const options = data.option;
  if (!Array.isArray(options)) return [];
  const variants: Record<string, unknown>[] = [];
  for (const option of options) {
    if (!option || typeof option !== "object") continue;
    const o = option as Record<string, unknown>;
    const productId = readString(o, "product_id", "productId", "id");
    const itemCode = readString(o, "sku", "itemCode", "item_code");
    const title = readString(o, "title", "name", "product_name");
    const images = normalizeImageItems(o.carousel_images ?? o.image_list);
    variants.push({
      productId,
      itemCode,
      title,
      isSelected: Boolean(o.is_selected),
      isHaveAvailableStock: o.is_have_available_stock,
      images,
      imageUrls: images.map((img) => img.popup || img.thumb),
    });
  }
  return variants;
}

export interface NormalizedImage {
  popup: string;
  thumb: string;
}

export function normalizeImageItems(value: unknown): NormalizedImage[] {
  if (!Array.isArray(value)) return [];
  const images: NormalizedImage[] = [];
  for (const item of value) {
    const image = normalizeImageItem(item);
    if (image.popup || image.thumb) images.push(image);
  }
  return images;
}

export function normalizeImageItem(value: unknown): NormalizedImage {
  if (typeof value === "string") {
    const text = value.trim();
    return { popup: text, thumb: text };
  }
  if (!value || typeof value !== "object") return { popup: "", thumb: "" };
  const v = value as Record<string, unknown>;
  const popup = readString(v, "popup", "url", "src", "image", "main_image");
  const thumb = readString(v, "thumb", "thumbnail", "thumb_url", "image");
  return { popup, thumb };
}

export function extractCsrfToken(html: string): string {
  for (const pattern of CSRF_PATTERNS) {
    const m = pattern.exec(html);
    if (m && m[1]) return m[1].trim();
  }
  return "";
}

function parseSuccessJson(resp: HttpResponse): Record<string, unknown> {
  let parsed: Record<string, unknown>;
  try {
    parsed = resp.text ? (JSON.parse(resp.text) as Record<string, unknown>) : {};
  } catch {
    throw new GigaB2BApiError(`response is not valid JSON: ${resp.text.slice(0, 200)}`, { statusCode: resp.status });
  }
  const code = parsed.code as string | number | null | undefined;
  if (![undefined, null, 0, 200, "0", "200"].includes(code)) {
    throw GigaB2BApiError.fromResponse(parsed, resp.status);
  }
  return parsed;
}

function parseWorkerJson(resp: HttpResponse): Record<string, unknown> {
  let parsed: Record<string, unknown>;
  try {
    parsed = resp.text ? (JSON.parse(resp.text) as Record<string, unknown>) : {};
  } catch {
    throw new GigaB2BApiError(`response is not valid JSON: ${resp.text.slice(0, 200)}`, { statusCode: resp.status });
  }
  if (parsed.success === false) {
    throw new GigaB2BApiError(String(parsed.error ?? JSON.stringify(parsed)), { statusCode: resp.status });
  }
  const data = parsed.data;
  return data && typeof data === "object" ? (data as Record<string, unknown>) : parsed;
}

export function responseDataDict(response: Record<string, unknown>): Record<string, unknown> {
  const data = response.data;
  return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
}

export function readString(source: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" || typeof value === "number") {
      const text = String(value).trim();
      if (text) return text;
    }
  }
  return "";
}

export function requireText(value: string | number, fieldName: string): string {
  const text = String(value).trim();
  if (!text) throw new Error(`${fieldName} is required`);
  return text;
}
