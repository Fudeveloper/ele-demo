/**
 * GIGA OpenAPI 签名客户端 —— 移植自 `gigab2b_openapi/client.py`。
 *
 * 端点（均为 POST JSON）：
 *   /b2b-overseas-api/v1/buyer/product/skus/v1
 *   /b2b-overseas-api/v1/buyer/product/detailInfo/v1
 *   /b2b-overseas-api/v1/buyer/product/price/v1
 *   /b2b-overseas-api/v1/buyer/inventory/quantity/v2
 */

import { generateNonce, generateSignature, currentMillis } from "./auth";
import { GigaB2BApiError, GigaB2BTransportError } from "./exceptions";
import { httpRequest, HttpTransportError, type HttpResponse } from "../http";
import type { Account } from "../../db/schema";

export const SANDBOX_BASE_URL = "https://openapi-sandbox.gigab2b.com";
export const PRODUCTION_BASE_URL = "https://openapi.gigab2b.com";

export const PRODUCT_SKUS_PATH = "/b2b-overseas-api/v1/buyer/product/skus/v1";
export const PRODUCT_DETAIL_INFO_PATH = "/b2b-overseas-api/v1/buyer/product/detailInfo/v1";
export const PRODUCT_PRICE_PATH = "/b2b-overseas-api/v1/buyer/product/price/v1";
export const INVENTORY_QUANTITY_PATH = "/b2b-overseas-api/v1/buyer/inventory/quantity/v2";

export interface GigaB2BClientOptions {
  clientId: string;
  clientSecret: string;
  baseUrl?: string;
  timeout?: number;
}

export class GigaB2BClient {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
  timeout: number;

  constructor(opts: GigaB2BClientOptions) {
    if (!opts.clientId) throw new Error("client_id is required");
    if (!opts.clientSecret) throw new Error("client_secret is required");
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.baseUrl = (opts.baseUrl ?? PRODUCTION_BASE_URL).replace(/\/+$/, "");
    this.timeout = opts.timeout ?? 30000;
  }

  /** 从账号记录构造客户端。 */
  static fromAccount(account: Pick<Account, "appid" | "secret" | "openapiBaseUrl">): GigaB2BClient {
    return new GigaB2BClient({
      clientId: account.appid,
      clientSecret: account.secret,
      baseUrl: account.openapiBaseUrl || PRODUCTION_BASE_URL,
    });
  }

  buildHeaders(apiPath: string): Record<string, string> {
    const timestamp = String(currentMillis());
    const nonce = generateNonce();
    const sign = generateSignature({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      apiPath,
      timestamp,
      nonce,
    });
    return {
      "Content-Type": "application/json",
      "client-id": this.clientId,
      timestamp,
      nonce,
      sign,
    };
  }

  async getProductSkus(opts: {
    page?: number;
    pageSize?: number;
    sort?: number;
    firstArrivalDate?: string;
    lastUpdatedAfter?: string;
    queryTimeType?: number;
    startTime?: string;
    endTime?: string;
  } = {}): Promise<Record<string, unknown>> {
    return this.post(PRODUCT_SKUS_PATH, buildProductSkusPayload(opts));
  }

  async getProductDetailInfo(opts: {
    skus?: string[];
    productNames?: string[];
  }): Promise<Record<string, unknown>> {
    return this.post(PRODUCT_DETAIL_INFO_PATH, buildProductDetailInfoPayload(opts));
  }

  async getProductPrice(skus: string[]): Promise<Record<string, unknown>> {
    if (!skus.length) throw new Error("skus cannot be empty");
    return this.post(PRODUCT_PRICE_PATH, { skus });
  }

  async getInventoryQuantity(skus: string[]): Promise<Record<string, unknown>> {
    if (!skus.length) throw new Error("skus cannot be empty");
    return this.post(INVENTORY_QUANTITY_PATH, { skus });
  }

  private async post(apiPath: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestJson("POST", apiPath, payload);
  }

  private async requestJson(
    method: string,
    apiPath: string,
    payload?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const url = `${this.baseUrl}${apiPath}`;
    const body = payload ? JSON.stringify(payload) : undefined;
    let resp: HttpResponse;
    try {
      resp = await httpRequest(url, {
        method,
        headers: this.buildHeaders(apiPath),
        body,
        timeoutMs: this.timeout,
      });
    } catch (err) {
      if (err instanceof HttpTransportError) {
        throw new GigaB2BTransportError(err.message);
      }
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

    if (!resp.ok) {
      throw GigaB2BApiError.fromResponse(parsed, resp.status);
    }
    if (parsed && parsed.success === false) {
      throw GigaB2BApiError.fromResponse(parsed, resp.status);
    }
    return parsed;
  }
}

export function buildProductDetailInfoPayload(opts: {
  skus?: string[];
  productNames?: string[];
}): Record<string, unknown> {
  const hasSkus = opts.skus !== undefined;
  const hasNames = opts.productNames !== undefined;
  if (hasSkus === hasNames) throw new Error("exactly one of skus or productNames must be provided");
  const field = hasSkus ? "skus" : "productNames";
  const values = (hasSkus ? opts.skus : opts.productNames) as string[];
  if (!values.length) throw new Error(`${field} cannot be empty`);
  if (values.length > 200) throw new Error(`${field} cannot contain more than 200 items`);
  if (values.some((v) => typeof v !== "string" || !v.trim())) {
    throw new Error(`${field} must contain non-empty strings`);
  }
  return { [field]: values };
}

export function buildProductSkusPayload(opts: {
  page?: number;
  pageSize?: number;
  sort?: number;
  firstArrivalDate?: string;
  lastUpdatedAfter?: string;
  queryTimeType?: number;
  startTime?: string;
  endTime?: string;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (opts.page !== undefined) {
    if (opts.page < 1) throw new Error("page must be greater than or equal to 1");
    payload.page = opts.page;
  }
  if (opts.pageSize !== undefined) {
    if (opts.pageSize < 100 || opts.pageSize > 10000) {
      throw new Error("page_size must be between 100 and 10000");
    }
    payload.pageSize = opts.pageSize;
  }
  if (opts.sort !== undefined) {
    if (![1, 2, 3, 4].includes(opts.sort)) throw new Error("sort must be one of 1, 2, 3, 4");
    payload.sort = opts.sort;
  }
  if (opts.firstArrivalDate) payload.firstArrivalDate = opts.firstArrivalDate;
  if (opts.lastUpdatedAfter) payload.lastUpdatedAfter = opts.lastUpdatedAfter;

  const hasTimeRange = Boolean(opts.startTime || opts.endTime);
  if (opts.queryTimeType !== undefined) {
    if (![1, 2].includes(opts.queryTimeType)) throw new Error("query_time_type must be 1 or 2");
    if (!opts.startTime || !opts.endTime) {
      throw new Error("start_time and end_time are required when query_time_type is provided");
    }
    payload.queryTimeType = opts.queryTimeType;
  } else if (hasTimeRange) {
    throw new Error("query_time_type is required when start_time or end_time is provided");
  }
  if (opts.startTime) payload.startTime = opts.startTime;
  if (opts.endTime) payload.endTime = opts.endTime;
  return payload;
}

/** 从 /skus/v1 响应中提取 sku 列表。 */
export function extractSkusFromProductSkusResponse(
  response: Record<string, unknown>,
  limit: number = 200,
): string[] {
  if (limit < 1 || limit > 200) throw new Error("limit must be between 1 and 200");
  const data = (response.data as Record<string, unknown>) ?? {};
  const records = (data.records as unknown[]) ?? [];
  if (!Array.isArray(records)) return [];
  const skus: string[] = [];
  for (const rec of records) {
    if (!rec || typeof rec !== "object") continue;
    const sku = (rec as Record<string, unknown>).sku;
    if (typeof sku === "string" && sku.trim()) skus.push(sku.trim());
    if (skus.length >= limit) break;
  }
  return skus;
}
