/**
 * 共享工具与类型。
 */

/** 当前 epoch 秒（对应原 utc_now，naive UTC+8）。 */
export function utcNow(): number {
  return Math.floor(Date.now() / 1000);
}

/** "YYYY-MM-DD HH:MM:SS" 格式（本地时区，与原 Python 一致）。 */
export function utcNowStr(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 毫秒时间戳。 */
export function currentMillis(): number {
  return Date.now();
}

export function formatDuration(seconds: number): string {
  if (!seconds || seconds < 0) return "0秒";
  if (seconds < 60) return `${Math.round(seconds)}秒`;
  const minutes = Math.floor(seconds / 60);
  const rem = Math.round(seconds % 60);
  if (minutes < 60) return rem ? `${minutes}分${rem}秒` : `${minutes}分`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return remMin ? `${hours}时${remMin}分` : `${hours}时`;
}

/** 安全 JSON 解析。 */
export function safeJsonParse<T = unknown>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** 切分数组为固定大小块。 */
export function chunks<T>(arr: T[], size: number): T[][] {
  if (size <= 0) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

/** 去重保序。 */
export function dedupe<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

/** HTML 反转义。 */
export function htmlUnescape(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** 把任意值规整为字符串，空/无效返回 ""。 */
export function firstString(...values: unknown[]): string {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

/** 统一的 API 响应封装（对应原 ok()/fail()）。 */
export interface ApiResult<T = unknown> {
  success: boolean;
  message?: string | undefined;
  data?: T | undefined;
}

export function ok<T>(data?: T): ApiResult<T> {
  return { success: true, ...(data !== undefined ? { data } : {}) };
}

export function fail(message: string): ApiResult<never> {
  return { success: false, message };
}
