/**
 * GIGA 网站收藏夹客户端 —— 移植自 `gigab2b_openapi/wishlist_client.py`。
 *
 * 非 OpenAPI，使用 cookie 登录态 + CSRF token。
 */

import { GigaB2BApiError, GigaB2BTransportError } from "./exceptions";
import { httpRequest, HttpTransportError, type HttpResponse } from "../http";
import type { Account } from "../../db/schema";

export const WEB_BASE_URL = "https://www.gigab2b.com";
export const ADD_PRODUCTS_TO_WISH_PATH = "/index.php?route=/account/wishlist/addProductsToWish";
export const DELETE_PRODUCTS_FROM_WISH_PATH = "/index.php?route=/account/wishlist/delProductsFromWish";
export const WISHLIST_PAGE_PATH = "/index.php?route=account/wishlist";
export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

export type ProductIds = string | number | Array<string | number>;

export interface WishlistClientOptions {
  cookie: string;
  csrfToken: string;
  deviceId?: string | undefined;
  baseUrl?: string | undefined;
  userAgent?: string | undefined;
  screen?: string | undefined;
  timeout?: number | undefined;
}

export class GigaB2BWishlistClient {
  cookie: string;
  csrfToken: string;
  deviceId: string;
  baseUrl: string;
  userAgent: string;
  screen: string;
  timeout: number;

  constructor(opts: WishlistClientOptions) {
    if (!opts.cookie?.trim()) throw new Error("cookie is required");
    if (!opts.csrfToken?.trim()) throw new Error("csrf_token is required");
    this.cookie = opts.cookie.trim();
    this.csrfToken = opts.csrfToken.trim();
    this.deviceId = (opts.deviceId || extractCookieValue(this.cookie, "gmd_device_id") || "").trim();
    this.baseUrl = (opts.baseUrl ?? WEB_BASE_URL).replace(/\/+$/, "");
    this.userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
    this.screen = opts.screen ?? "1920x1080";
    this.timeout = opts.timeout ?? 30000;
  }

  static fromAccount(
    account: Pick<Account, "cookie" | "csrfToken" | "deviceId" | "webBaseUrl" | "userAgent" | "screen">,
  ): GigaB2BWishlistClient {
    return new GigaB2BWishlistClient({
      cookie: account.cookie,
      csrfToken: account.csrfToken ?? "",
      deviceId: account.deviceId ?? undefined,
      baseUrl: account.webBaseUrl || WEB_BASE_URL,
      userAgent: account.userAgent ?? undefined,
      screen: account.screen ?? undefined,
    });
  }

  buildHeaders(pageUrl: string, refererUrl: string): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
      "Content-Type": "application/json",
      Cookie: this.cookie,
      "Ori-Status-In-Response": "code",
      Origin: this.baseUrl,
      Referer: pageUrl,
      "User-Agent": this.userAgent,
      "X-Csrf-Token": this.csrfToken,
      "X-Gmd-Page-Url": pageUrl,
      "X-Gmd-Referer-Url": refererUrl,
      "X-Gmd-Screen": this.screen,
      "X-Requested-With": "XMLHttpRequest, XMLHttpRequest",
    };
    if (this.deviceId) headers["X-Gmd-Device-Id"] = this.deviceId;
    return headers;
  }

  async addProductsToWish(
    productIds: ProductIds,
    opts: { groupId?: number; source?: string; pageUrl?: string; refererUrl?: string } = {},
  ): Promise<Record<string, unknown>> {
    const productIdsText = buildProductIdsValue(productIds);
    const firstProductId = productIdsText.split(",", 1)[0];
    const pageUrl =
      opts.pageUrl || `${this.baseUrl}/index.php?route=product/product&product_id=${firstProductId}`;
    const refererUrl = opts.refererUrl || pageUrl;
    return this.post(ADD_PRODUCTS_TO_WISH_PATH, {
      product_ids: productIdsText,
      group_id: opts.groupId ?? 0,
      source: opts.source ?? "",
    }, pageUrl, refererUrl);
  }

  favoriteProducts = this.addProductsToWish;

  async deleteProductsFromWish(
    productIds: ProductIds,
    opts: { pageUrl?: string; refererUrl?: string } = {},
  ): Promise<Record<string, unknown>> {
    const pageUrl = opts.pageUrl || `${this.baseUrl}${WISHLIST_PAGE_PATH}`;
    const refererUrl = opts.refererUrl || `${pageUrl}&tab=all&secondTab=all`;
    return this.post(
      DELETE_PRODUCTS_FROM_WISH_PATH,
      { product_ids: buildProductIdsValue(productIds) },
      pageUrl,
      refererUrl,
    );
  }

  unfavoriteProducts = this.deleteProductsFromWish;

  private async post(
    path: string,
    payload: Record<string, unknown>,
    pageUrl: string,
    refererUrl: string,
  ): Promise<Record<string, unknown>> {
    const url = `${this.baseUrl}${path}`;
    let resp: HttpResponse;
    try {
      resp = await httpRequest(url, {
        method: "POST",
        headers: this.buildHeaders(pageUrl, refererUrl),
        body: JSON.stringify(payload),
        timeoutMs: this.timeout,
      });
    } catch (err) {
      if (err instanceof HttpTransportError) throw new GigaB2BTransportError(err.message);
      throw new GigaB2BTransportError(String((err as Error).message ?? err));
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = resp.text ? (JSON.parse(resp.text) as Record<string, unknown>) : {};
    } catch {
      throw new GigaB2BApiError(`response is not valid JSON: ${resp.text.slice(0, 200)}`, {
        statusCode: resp.status,
      });
    }
    if (!resp.ok) throw GigaB2BApiError.fromResponse(parsed, resp.status);
    if (isFailedResponse(parsed)) throw GigaB2BApiError.fromResponse(parsed, resp.status);
    return parsed;
  }
}

export function buildProductIdsValue(productIds: ProductIds): string {
  const rawValues: Array<string | number> = Array.isArray(productIds)
    ? productIds
    : [productIds];
  const normalized: string[] = [];
  for (const raw of rawValues) {
    const text = String(raw).trim();
    if (!text) continue;
    for (const part of text.split(",")) {
      const t = part.trim();
      if (t) normalized.push(t);
    }
  }
  if (!normalized.length) throw new Error("product_ids cannot be empty");
  return normalized.join(",");
}

export function extractCookieValue(cookie: string, name: string): string | null {
  const prefix = `${name}=`;
  for (const part of cookie.split(";")) {
    const item = part.trim();
    if (item.startsWith(prefix)) return item.slice(prefix.length);
  }
  return null;
}

export function isFailedResponse(response: Record<string, unknown>): boolean {
  if (response.success === false) return true;
  const code = response.code;
  return code !== undefined && code !== null && String(code) !== "200";
}
