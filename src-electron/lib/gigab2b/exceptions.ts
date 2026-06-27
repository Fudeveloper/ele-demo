/**
 * GIGA OpenAPI 异常类型 —— 对应原 `gigab2b_openapi/exceptions.py`。
 */

export class GigaB2BError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GigaB2BError";
  }
}

export class GigaB2BTransportError extends GigaB2BError {
  constructor(message: string) {
    super(message);
    this.name = "GigaB2BTransportError";
  }
}

export interface GigaB2BApiErrorOptions {
  code?: string | null | undefined;
  subMsg?: string | null | undefined;
  requestId?: string | null | undefined;
  statusCode?: number | null | undefined;
  response?: Record<string, unknown> | undefined;
}

export class GigaB2BApiError extends GigaB2BError {
  code: string | null;
  subMsg: string | null;
  requestId: string | null;
  statusCode: number | null;
  response: Record<string, unknown>;

  constructor(message: string, opts: GigaB2BApiErrorOptions = {}) {
    super(message);
    this.name = "GigaB2BApiError";
    this.code = opts.code ?? null;
    this.subMsg = opts.subMsg ?? null;
    this.requestId = opts.requestId ?? null;
    this.statusCode = opts.statusCode ?? null;
    this.response = opts.response ?? {};
  }

  static fromResponse(response: Record<string, unknown>, statusCode?: number | null): GigaB2BApiError {
    const message = String(
      (response.msg as string) || (response.subMsg as string) || "GIGA API request failed",
    );
    return new GigaB2BApiError(message, {
      code: response.code !== undefined && response.code !== null ? String(response.code) : null,
      subMsg: (response.subMsg as string) ?? null,
      requestId: (response.requestId as string) ?? null,
      statusCode,
      response,
    });
  }
}

export class ProductImageUrlExportError extends GigaB2BError {
  constructor(message: string) {
    super(message);
    this.name = "ProductImageUrlExportError";
  }
}

export class ProductImageGenerationError extends GigaB2BError {
  constructor(message: string) {
    super(message);
    this.name = "ProductImageGenerationError";
  }
}

/** 判断业务访问受限异常（用于自动收藏触发）。 */
export function isBusinessAccessRestriction(err: unknown): boolean {
  if (!(err instanceof GigaB2BApiError)) return false;
  const text = `${err.message} ${err.subMsg ?? ""} ${err.code ?? ""}`.toLowerCase();
  return (
    text.includes("business access") ||
    text.includes("限制访问") ||
    text.includes("未开通") ||
    text.includes("无权限") ||
    text.includes("权限不足")
  );
}
