/**
 * 网站页面抓取辅助 —— 对应 services.py 的 fetch/extract 系列函数。
 */

import { GigaB2BApiError } from "../lib/gigab2b/exceptions";
import { extractCsrfToken } from "../lib/gigab2b/anonymousProductClient";
import { WEB_BASE_URL as GIGAB2B_WEB_BASE_URL } from "../lib/gigab2b/wishlistClient";
import { extractCookieValue } from "../lib/gigab2b/wishlistClient";
import { httpRequest } from "../lib/http";
import { htmlUnescape } from "../lib/util";

export const PRODUCT_ID_FROM_URL = /(?:product_id=|\/product\/)(\d+)/;

export function parseProductId(value: string): string {
  const m = PRODUCT_ID_FROM_URL.exec(value);
  if (m && m[1]) return m[1];
  if (/^\d+$/.test(value.trim())) return value.trim();
  return "";
}

export function looksLikeLoginPage(html: string): boolean {
  const lower = html.toLowerCase();
  return (
    lower.includes("login_flag") === false &&
    (lower.includes('id="login"') ||
      lower.includes('class="login') ||
      lower.includes("please log in") ||
      lower.includes("请登录"))
  );
}

export async function fetchWebPage(opts: {
  cookie: string;
  url: string;
  userAgent?: string | undefined;
  timeout?: number | undefined;
}): Promise<string> {
  const headers: Record<string, string> = {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    Cookie: opts.cookie,
  };
  if (opts.userAgent) headers["User-Agent"] = opts.userAgent;
  const resp = await httpRequest(opts.url, {
    headers,
    timeoutMs: opts.timeout ?? 30000,
  });
  return resp.text;
}

export function extractProductIds(html: string): string[] {
  const ids = new Set<string>();
  // data-product-id="123" / product_id=123 / /product/123
  const re = /(?:data-product-id=["'](\d+)|product_id=(\d+)|\/product\/(\d+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const id = m[1] || m[2] || m[3];
    if (id) ids.add(id);
  }
  return Array.from(ids);
}

/** 从 baseInfos 响应提取 item_code（sku）。 */
export function extractItemCodeFromBaseInfos(response: Record<string, unknown>): string {
  const data = (response.data as Record<string, unknown>) ?? {};
  const info = data.product_info as Record<string, unknown> | undefined;
  if (!info) return "";
  const sku = info.sku ?? info.itemCode ?? info.item_code;
  if (typeof sku === "string" && sku.trim()) return sku.trim();
  return "";
}

/** 调用网站 baseInfos 接口取 item_code。 */
export async function fetchProductBaseInfoItemCode(opts: {
  cookie: string;
  productId: string;
  csrfToken: string;
  baseUrl: string;
  userAgent?: string | undefined;
}): Promise<string> {
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/index.php?route=product/info/info/baseInfos&product_id=${encodeURIComponent(opts.productId)}`;
  const headers: Record<string, string> = {
    Accept: "application/json, text/plain, */*",
    Cookie: opts.cookie,
    "Ori-Status-In-Response": "code",
    Referer: `${opts.baseUrl.replace(/\/+$/, "")}/index.php?route=product/product&product_id=${encodeURIComponent(opts.productId)}`,
    "X-Requested-With": "XMLHttpRequest, XMLHttpRequest",
  };
  if (opts.csrfToken) headers["X-CSRF-TOKEN"] = opts.csrfToken;
  if (opts.userAgent) headers["User-Agent"] = opts.userAgent;
  const resp = await httpRequest(url, { headers, timeoutMs: 30000 });
  let parsed: Record<string, unknown>;
  try {
    parsed = resp.text ? (JSON.parse(resp.text) as Record<string, unknown>) : {};
  } catch {
    throw new GigaB2BApiError(`baseInfos response is not valid JSON`, { statusCode: resp.status });
  }
  return extractItemCodeFromBaseInfos(parsed);
}

export { extractCsrfToken, extractCookieValue, htmlUnescape, GIGAB2B_WEB_BASE_URL };
