/**
 * 账号服务 —— 移植自 services.py 的账号相关函数。
 */

import { eq, inArray } from "drizzle-orm";
import { getDb } from "../db";
import { accounts, type Account } from "../db/schema";
import { getConfig } from "../config";
import { utcNow } from "../lib/util";
import { extractCookieValue, WEB_BASE_URL as GIGAB2B_WEB_BASE_URL } from "../lib/gigab2b/wishlistClient";
import { extractCsrfToken } from "../lib/gigab2b/anonymousProductClient";
import {
  fetchProductBaseInfoItemCode,
  fetchWebPage,
  looksLikeLoginPage,
  GIGAB2B_WEB_BASE_URL as WEB_BASE,
} from "./webFetch";

export const CSV_COLUMNS = ["account_name", "appid", "secret", "cookie", "remark"];
const PROBE_PRODUCT_ID = "1442692";

export function enabledAccounts(accountIds: number[]): Account[] {
  if (!accountIds.length) throw new Error("请选择至少一个启用账号");
  const list = getDb()
    .select()
    .from(accounts)
    .where(inArray(accounts.id, accountIds))
    .all()
    .filter((a) => a.enabled);
  if (!list.length) throw new Error("请选择至少一个启用账号");
  return list;
}

export interface ValidateResult {
  csrfToken: string;
  deviceId: string;
  message: string;
}

/** 校验账号 cookie + secret 可用性。 */
export async function validateAccount(opts: {
  appid: string;
  secret: string;
  cookie: string;
}): Promise<ValidateResult> {
  const { appid, secret, cookie } = opts;
  if (!cookie.includes("OCSESSID=") && !cookie.includes("login_flag=1")) {
    throw new Error("cookie 缺少 OCSESSID 或 login_flag 登录态字段");
  }
  const cfg = getConfig();
  const baseUrl = cfg.gigab2bWebBaseUrl || WEB_BASE;
  // 探针：拉取 wishlist 页面验证登录态
  const html = await fetchWebPage({
    cookie,
    url: `${baseUrl}/index.php?route=account/wishlist`,
  });
  if (looksLikeLoginPage(html)) {
    throw new Error("cookie 已过期或未登录");
  }
  const csrfToken = extractCsrfToken(html);
  const itemCode = await fetchProductBaseInfoItemCode({
    cookie,
    productId: PROBE_PRODUCT_ID,
    csrfToken,
    baseUrl,
  });
  if (!itemCode) {
    throw new Error(`baseInfos 接口未返回 sku: product_id=${PROBE_PRODUCT_ID}`);
  }
  const message = csrfToken
    ? `测活成功：cookie 可访问商品 ${itemCode}`
    : `测活成功：cookie 可访问商品 ${itemCode}，但未解析到 csrf；收藏操作时会再次尝试解析`;
  return {
    csrfToken,
    deviceId: extractCookieValue(cookie, "gmd_device_id") ?? "",
    message,
  };
}

export async function testAccountLiveness(account: Account): Promise<ValidateResult & { status: string }> {
  const result = await validateAccount({
    appid: account.appid,
    secret: account.secret,
    cookie: account.cookie,
  });
  const db = getDb();
  const now = utcNow();
  db.update(accounts)
    .set({
      csrfToken: result.csrfToken || account.csrfToken || null,
      deviceId: result.deviceId || account.deviceId || null,
      lastValidatedAt: now,
      updatedAt: now,
    })
    .where(eq(accounts.id, account.id))
    .run();
  return { status: "alive", ...result };
}

export interface ImportRow {
  account_name?: string;
  appid?: string;
  secret?: string;
  cookie?: string;
  remark?: string;
}

/** 解析 CSV 文本为行（简单实现，支持引号）。 */
export function parseCsv(text: string): ImportRow[] {
  const clean = text.replace(/^\ufeff/, "");
  const lines = clean.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const header = splitCsvLine(lines[0] ?? "").map((h) => h.trim());
  if (!header.length) throw new Error("CSV header is required");
  if (!header.includes("appid") || !header.includes("secret")) {
    throw new Error("CSV 缺少必填列: appid, secret");
  }
  const rows: ImportRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i] ?? "");
    const row: ImportRow = {};
    header.forEach((h, idx) => {
      const v = cells[idx] ?? "";
      if (h in row.constructor.prototype) return;
      (row as Record<string, string>)[h] = v;
    });
    rows.push(row);
  }
  return rows;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuote && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuote = !inQuote;
      }
    } else if (c === "," && !inQuote) {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

export interface ImportRowResult {
  line: number;
  appid: string;
  success: boolean;
  action: string;
  message: string;
  account_id?: number;
}

export async function importAccountsCsv(csvText: string, validate = true): Promise<ImportRowResult[]> {
  const rows = parseCsv(csvText);
  const cfg = getConfig();
  const db = getDb();
  const results: ImportRowResult[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const lineNumber = i + 2;
    const appid = (row.appid ?? "").trim();
    const secret = (row.secret ?? "").trim();
    const base: ImportRowResult = { line: lineNumber, appid, success: false, action: "", message: "" };
    if (!appid || !secret) {
      results.push({ ...base, message: "appid、secret 为必填" });
      continue;
    }
    const cookie = (row.cookie ?? "").trim();
    const accountName = (row.account_name ?? "").trim() || `账号-${appid.slice(-6)}`;
    try {
      let csrfToken = "";
      let deviceId = "";
      let validationMsg = "导入成功";
      if (validate && cookie) {
        const v = await validateAccount({ appid, secret, cookie });
        csrfToken = v.csrfToken;
        deviceId = v.deviceId;
        validationMsg = v.message;
      }
      const existing = db.select().from(accounts).where(eq(accounts.appid, appid)).get();
      const now = utcNow();
      if (existing) {
        db.update(accounts)
          .set({
            accountName,
            secret,
            cookie,
            csrfToken: csrfToken || existing.csrfToken || null,
            deviceId: deviceId || existing.deviceId || extractCookieValue(cookie, "gmd_device_id") || existing.deviceId || null,
            screen: existing.screen ?? "1920x1080",
            webBaseUrl: cfg.gigab2bWebBaseUrl,
            openapiBaseUrl: cfg.gigab2bOpenapiBaseUrl,
            remark: (row.remark ?? "").trim() || null,
            enabled: true,
            lastValidatedAt: now,
            updatedAt: now,
          })
          .where(eq(accounts.id, existing.id))
          .run();
        results.push({ ...base, success: true, action: "updated", account_id: existing.id, message: validationMsg });
      } else {
        const created = db
          .insert(accounts)
          .values({
            accountName,
            appid,
            secret,
            cookie,
            csrfToken: csrfToken || null,
            deviceId: deviceId || extractCookieValue(cookie, "gmd_device_id") || null,
            screen: "1920x1080",
            webBaseUrl: cfg.gigab2bWebBaseUrl,
            openapiBaseUrl: cfg.gigab2bOpenapiBaseUrl,
            remark: (row.remark ?? "").trim() || null,
            enabled: true,
            lastValidatedAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .returning()
          .get();
        results.push({ ...base, success: true, action: "created", account_id: created.id, message: validationMsg });
      }
    } catch (err) {
      results.push({ ...base, message: String((err as Error).message ?? err) });
    }
  }
  return results;
}

export function summarizeAccountImport(results: ImportRowResult[]): Record<string, number> {
  const created = results.filter((r) => r.success && r.action === "created").length;
  const updated = results.filter((r) => r.success && r.action === "updated").length;
  const failed = results.filter((r) => !r.success).length;
  const success = results.filter((r) => r.success).length;
  return { created, updated, failed, success, total: results.length };
}

/** 确保账号有 csrf_token（用于收藏/取消收藏）。 */
export async function ensureAccountCsrf(account: Account): Promise<void> {
  if (account.csrfToken) return;
  const cfg = getConfig();
  const baseUrl = account.webBaseUrl || cfg.gigab2bWebBaseUrl || WEB_BASE;
  const html = await fetchWebPage({
    cookie: account.cookie,
    url: `${baseUrl}/index.php?route=account/wishlist`,
    userAgent: account.userAgent ?? undefined,
  });
  const token = extractCsrfToken(html);
  if (!token) throw new Error("无法解析 csrf_token，请重新导入最新 cookie");
  const db = getDb();
  db.update(accounts).set({ csrfToken: token, updatedAt: utcNow() }).where(eq(accounts.id, account.id)).run();
  account.csrfToken = token;
}

export { GIGAB2B_WEB_BASE_URL };
