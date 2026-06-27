/**
 * 本地图片上传与收藏取消 —— 移植自 services.py 的相关函数。
 */

import path from "node:path";
import { promises as fs, mkdirSync } from "node:fs";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "../db";
import { accounts, products, type Account, type Product } from "../db/schema";
import { getConfig } from "../config";
import { utcNow, chunks } from "../lib/util";
import { imageUrlsFromProduct } from "../lib/image/imageMap";
import { upsertProduct, sanitizeFilenamePart } from "./productSync";
import { fetchWishlistProductIds } from "./syncHelpers";
import { makeWishlistClient } from "./productSync";
import type { JobProgress } from "./jobs";

const ALLOWED_LOCAL_IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];

export interface UploadedFile {
  name: string;
  data: Buffer;
}

/** 创建本地上传商品。 */
export async function createLocalImageProduct(opts: {
  accountId: number;
  itemCode: string;
  productName: string;
  files: UploadedFile[];
}): Promise<Product> {
  const db = getDb();
  const cfg = getConfig();
  const account = db.select().from(accounts).where(eq(accounts.id, opts.accountId)).get();
  if (!account || !account.enabled) throw new Error("请选择一个启用账号");
  const files = opts.files.filter((f) => f.name);
  if (!files.length) throw new Error("请至少上传一张图片");

  const timestamp = formatTimestamp(utcNow());
  const cleanItemCode = opts.itemCode.trim() || `本地上传-${timestamp}`;
  const safeItemCode = sanitizeFilenamePart(cleanItemCode, "item");
  const outputDir = path.join(cfg.localImagesRoot, String(account.id), safeItemCode);
  mkdirSync(outputDir, { recursive: true });

  const imageUrls: string[] = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    const suffix = path.extname(file.name).toLowerCase();
    if (!ALLOWED_LOCAL_IMAGE_EXTENSIONS.includes(suffix)) {
      throw new Error(`不支持的图片格式: ${file.name}`);
    }
    const index = i + 1;
    const stem = sanitizeFilenamePart(path.basename(file.name, suffix), `image-${index}`);
    const target = path.join(outputDir, `${String(index).padStart(2, "0")}-${stem}${suffix}`);
    if (!file.data.length) throw new Error("图片文件为空");
    await fs.writeFile(target, file.data);
    const relativePath = `local-images/${account.id}/${safeItemCode}/${path.basename(target)}`.replace(/\\/g, "/");
    imageUrls.push(`/api/files/${relativePath}`);
  }

  const productData = {
    sku: cleanItemCode,
    itemCode: cleanItemCode,
    productName: opts.productName.trim() || cleanItemCode,
    imageUrls,
    source: "local_upload",
  };
  const [product] = await upsertProduct(account, productData, { enrichAnonymous: false });
  return product;
}

function formatTimestamp(epoch: number): string {
  const d = new Date(epoch * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export interface CancelFavoritesResult {
  total: number;
  success: number;
  fail: number;
  accounts: unknown[];
  errors: string[];
  durationMs: number;
}

/** 取消账号的所有收藏。 */
export async function cancelAllFavorites(accountIds: number[], progress?: JobProgress): Promise<CancelFavoritesResult> {
  const db = getDb();
  const startedAt = Date.now();
  const result: CancelFavoritesResult = { total: 0, success: 0, fail: 0, accounts: [], errors: [], durationMs: 0 };
  const list = db.select().from(accounts).where(inArray(accounts.id, accountIds)).all();
  for (const account of list) {
    const accountResult: Record<string, unknown> = {
      account_id: account.id,
      account_name: account.accountName,
      total: 0,
      success: 0,
      fail: 0,
      chunks: [] as unknown[],
      errors: [] as string[],
    };
    try {
      const productIds = await fetchWishlistProductIds(account);
      accountResult.total = productIds.length;
      result.total += productIds.length;
      progress?.addTotal(productIds.length);
      const wishlist = await makeWishlistClient(account as Account);
      for (const chunkIds of chunks(productIds, 50)) {
        const chunkResult: Record<string, unknown> = { count: chunkIds.length, success: false, message: "" };
        try {
          const resp = await wishlist.deleteProductsFromWish(chunkIds);
          chunkResult.success = true;
          chunkResult.message = (resp.msg as string) || "ok";
          accountResult.success = (accountResult.success as number) + chunkIds.length;
          result.success += chunkIds.length;
          progress?.success(chunkIds.length);
        } catch (err) {
          chunkResult.message = String(err);
          (accountResult.errors as string[]).push(String(err));
          accountResult.fail = (accountResult.fail as number) + chunkIds.length;
          result.fail += chunkIds.length;
          progress?.fail(chunkIds.length, String(err));
        }
        (accountResult.chunks as unknown[]).push(chunkResult);
      }
    } catch (err) {
      accountResult.fail = (accountResult.fail as number) + 1;
      result.fail += 1;
      result.errors.push(`${account.accountName}: ${err}`);
    }
    result.accounts.push(accountResult);
  }
  result.durationMs = Date.now() - startedAt;
  return result;
}

void imageUrlsFromProduct;
