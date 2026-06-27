/**
 * 轻量 HTTP 客户端：基于全局 fetch + AbortController 超时。
 * 对应原 Python `requests.request`。
 */

export interface HttpResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  /** 原始字节数组。 */
  bytes: Uint8Array;
  text: string;
}

export interface HttpRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  /** JSON body（对象）或原始字符串/Buffer。 */
  body?: unknown;
  timeoutMs?: number;
  /** 是否跟随重定向（默认 true）。 */
  redirect?: RequestRedirect;
}

/** HTTP 传输异常（网络层失败）。 */
export class HttpTransportError extends Error {
  override cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "HttpTransportError";
    this.cause = cause;
  }
}

function serializeBody(body: unknown, headers: Record<string, string>): BodyInit | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return body as unknown as BodyInit;
  if (body instanceof ArrayBuffer) return body;
  // 对象 -> JSON
  if (!headers["Content-Type"] && !headers["content-type"]) {
    headers["Content-Type"] = "application/json";
  }
  return JSON.stringify(body);
}

export async function httpRequest(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  const body = serializeBody(options.body, headers);
  const method = (options.method ?? "GET").toUpperCase();

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 30000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let resp: Response;
  try {
    const init: RequestInit = {
      method,
      headers,
      redirect: options.redirect ?? "follow",
      signal: controller.signal,
    };
    if (body !== undefined) init.body = body;
    resp = await fetch(url, init);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new HttpTransportError(`request timeout after ${timeoutMs}ms: ${url}`);
    }
    throw new HttpTransportError(`request failed: ${url}: ${(err as Error).message}`, err);
  } finally {
    clearTimeout(timer);
  }

  const buf = new Uint8Array(await resp.arrayBuffer());
  const text = new TextDecoder("utf-8").decode(buf);
  return {
    status: resp.status,
    ok: resp.ok,
    headers: resp.headers,
    bytes: buf,
    text,
  };
}

/** 发送请求并解析为 JSON 对象。 */
export async function httpRequestJson<T = Record<string, unknown>>(
  url: string,
  options: HttpRequestOptions = {},
): Promise<T> {
  const resp = await httpRequest(url, options);
  if (!resp.text) return {} as T;
  try {
    return JSON.parse(resp.text) as T;
  } catch {
    throw new HttpTransportError(`response is not valid JSON: ${resp.text.slice(0, 200)}`);
  }
}

/** 流式请求（用于 SSE / chunked 流式响应透传）。返回可读流。 */
export async function httpRequestStream(
  url: string,
  options: HttpRequestOptions = {},
): Promise<{ status: number; headers: Headers; body: ReadableStream<Uint8Array> | null }> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  const body = serializeBody(options.body, headers);
  const method = (options.method ?? "GET").toUpperCase();
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 600000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let resp: Response;
  try {
    const init: RequestInit = {
      method,
      headers,
      redirect: options.redirect ?? "follow",
      signal: controller.signal,
    };
    if (body !== undefined) init.body = body;
    resp = await fetch(url, init);
  } catch (err) {
    clearTimeout(timer);
    throw new HttpTransportError(`stream request failed: ${url}: ${(err as Error).message}`, err);
  }
  // 流式响应不能用固定超时；读取过程中保持活跃
  void timer;
  return { status: resp.status, headers: resp.headers, body: resp.body };
}
