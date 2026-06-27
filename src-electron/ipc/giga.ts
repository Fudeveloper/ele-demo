/**
 * GIGA 业务 IPC 处理器 —— 对应原 Flask `/api/*` 路由。
 * 全部通过 `ipcMain.handle` 暴露给渲染进程。
 */

import { ipcMain, BrowserWindow } from "electron";
import { desc, eq, inArray, like, or, sql, and, count as countFn } from "drizzle-orm";
import { getDb } from "../db";
import { accounts, jobs, products } from "../db/schema";
import { ok, fail, type ApiResult } from "../lib/util";
import { safeJsonParse } from "../lib/util";
import { accountToDict, productToDict, syncImageCounts } from "../services/serialization";
import { jobToDict } from "../services/jobs";
import {
  importAccountsCsv,
  summarizeAccountImport,
  testAccountLiveness,
} from "../services/accounts";
import {
  syncManualProducts,
  syncAllProductsForAccounts,
} from "../services/productSync";
import { syncPriceInventoryCache } from "../services/priceInventory";
import { syncProductSkuInfo } from "../services/sku";
import { cancelAllFavorites, createLocalImageProduct } from "../services/localImages";
import {
  generateProductImages,
  approveProductImage,
  rejectProductImage,
} from "../services/images";
import {
  syncProductToWpsCloudDoc,
  syncProductsToWpsCloudDoc,
} from "../services/wps";
import { startJob } from "../services/jobs";
import { ensureImageProcessMap, imageUrlsFromProduct, markProcessing } from "../lib/image/imageMap";
import { countImageStatuses } from "../lib/image/imageMap";
import { utcNow } from "../lib/util";

function intList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => Number(v)).filter((n) => Number.isInteger(n));
}

function withFileUrls(imageMap: Record<string, unknown>): Record<string, unknown> {
  const items = imageMap.items as Record<string, unknown>[] | undefined;
  if (Array.isArray(items)) {
    for (const item of items) {
      const candidates = item.candidates as Record<string, unknown>[] | undefined;
      if (Array.isArray(candidates)) {
        for (const c of candidates) {
          const p = (c.path as string) ?? "";
          c.url = p ? `/api/files/${p}` : "";
        }
      }
    }
  }
  return imageMap;
}

export function registerGigaIpc() {
  // ---------- 账号 ----------
  ipcMain.handle("accounts:list", async (): Promise<ApiResult> => {
    const db = getDb();
    const accs = db.select().from(accounts).orderBy(desc(accounts.id)).all();
    const stats = db
      .select({ accountId: products.accountId, count: countFn(), maxSynced: sql<number>`max(${products.syncedAt})` })
      .from(products)
      .groupBy(products.accountId)
      .all();
    const productStats = new Map(stats.map((s) => [s.accountId, s]));
    const items = accs.map((a) => {
      const d = accountToDict(a);
      const s = productStats.get(a.id!);
      d.product_count = s?.count ?? 0;
      d.last_synced_at = s?.maxSynced ?? "";
      return d;
    });
    return ok({ items });
  });

  ipcMain.handle("accounts:create", async (_e, payload): Promise<ApiResult> => {
    const appid = String(payload?.appid ?? "").trim();
    const secret = String(payload?.secret ?? "").trim();
    if (!appid || !secret) return fail("appid 和 secret 为必填");
    const db = getDb();
    const existing = db.select().from(accounts).where(eq(accounts.appid, appid)).get();
    if (existing) return fail(`appid ${appid} 已存在`);
    const now = utcNow();
    const created = db
      .insert(accounts)
      .values({
        appid,
        secret,
        cookie: String(payload?.cookie ?? "").trim(),
        accountName: String(payload?.account_name ?? "").trim() || `账号-${appid.slice(-6)}`,
        remark: String(payload?.remark ?? "").trim() || null,
        enabled: true,
        screen: "1920x1080",
        webBaseUrl: "",
        openapiBaseUrl: "",
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    return ok({ item: accountToDict(created) });
  });

  ipcMain.handle("accounts:update", async (_e, id, payload): Promise<ApiResult> => {
    const db = getDb();
    const acc = db.select().from(accounts).where(eq(accounts.id, id)).get();
    if (!acc) return fail("账号不存在");
    const patch: Record<string, unknown> = { updatedAt: utcNow() };
    if (payload?.enabled !== undefined) patch.enabled = Boolean(payload.enabled);
    if (payload?.account_name !== undefined) patch.accountName = String(payload.account_name).trim() || acc.accountName;
    if (payload?.remark !== undefined) patch.remark = String(payload.remark).trim() || null;
    db.update(accounts).set(patch).where(eq(accounts.id, id)).run();
    const updated = db.select().from(accounts).where(eq(accounts.id, id)).get()!;
    return ok({ item: accountToDict(updated) });
  });

  ipcMain.handle("accounts:replace", async (_e, id, payload): Promise<ApiResult> => {
    const db = getDb();
    const acc = db.select().from(accounts).where(eq(accounts.id, id)).get();
    if (!acc) return fail("账号不存在");
    const patch: Record<string, unknown> = { updatedAt: utcNow() };
    if (payload?.account_name !== undefined) patch.accountName = String(payload.account_name).trim() || acc.accountName;
    if (payload?.secret !== undefined) patch.secret = String(payload.secret).trim() || acc.secret;
    if (payload?.cookie !== undefined) patch.cookie = String(payload.cookie).trim();
    if (payload?.remark !== undefined) patch.remark = String(payload.remark).trim() || null;
    if (payload?.enabled !== undefined) patch.enabled = Boolean(payload.enabled);
    db.update(accounts).set(patch).where(eq(accounts.id, id)).run();
    const updated = db.select().from(accounts).where(eq(accounts.id, id)).get()!;
    return ok({ item: accountToDict(updated) });
  });

  ipcMain.handle("accounts:delete", async (_e, id): Promise<ApiResult> => {
    const db = getDb();
    db.delete(accounts).where(eq(accounts.id, id)).run();
    return ok({ deleted_id: id });
  });

  ipcMain.handle("accounts:batchDelete", async (_e, payload): Promise<ApiResult> => {
    const ids = intList(payload?.account_ids);
    if (!ids.length) return fail("请选择账号");
    const db = getDb();
    const result = db.delete(accounts).where(inArray(accounts.id, ids)).run();
    return ok({ deleted: result.changes });
  });

  ipcMain.handle("accounts:test", async (_e, id): Promise<ApiResult> => {
    const db = getDb();
    const acc = db.select().from(accounts).where(eq(accounts.id, id)).get();
    if (!acc) return fail("账号不存在");
    try {
      const result = await testAccountLiveness(acc);
      return ok({ result });
    } catch (err) {
      return fail(String((err as Error).message ?? err));
    }
  });

  ipcMain.handle("accounts:importCsv", async (_e, csvText): Promise<ApiResult> => {
    try {
      const results = await importAccountsCsv(String(csvText ?? ""), true);
      const summary = summarizeAccountImport(results);
      return ok({ items: results, summary });
    } catch (err) {
      return fail(String((err as Error).message ?? err));
    }
  });

  ipcMain.handle("accounts:sync", async (_e, id, payload): Promise<ApiResult> => {
    const full = Boolean(payload?.full);
    try {
      const r = await syncAllProductsForAccounts([id], { full });
      const label = full ? "全量同步" : "同步新收藏";
      const durationS = Math.round(r.durationMs / 100) / 10;
      return ok({ message: `${label}完成，共 ${r.totalSynced} 个商品（新增 ${r.totalNew}），耗时 ${durationS} 秒` });
    } catch (err) {
      return fail(`同步失败: ${err}`);
    }
  });

  // ---------- 商品 ----------
  ipcMain.handle("products:list", async (_e, params): Promise<ApiResult> => {
    const db = getDb();
    const accountId = params?.account_id ? Number(params.account_id) : undefined;
    const keyword = String(params?.keyword ?? "").trim();
    const itemCode = String(params?.item_code ?? "").trim();
    const productId = String(params?.product_id ?? "").trim();
    const imageProcessStatus = String(params?.image_process_status ?? "").trim();
    const showHidden = Boolean(params?.show_hidden);
    const page = Math.max(Number(params?.page ?? 1) || 1, 1);
    const perPage = Math.min(Math.max(Number(params?.per_page ?? 20) || 20, 1), 200);
    const search = String(params?.search ?? "").trim();

    const conditions = [];
    if (!showHidden) conditions.push(eq(products.hidden, false));
    if (accountId) conditions.push(eq(products.accountId, accountId));
    if (keyword) conditions.push(like(products.productName, `%${keyword}%`));
    if (itemCode) conditions.push(like(products.itemCode, `%${itemCode}%`));
    if (productId) conditions.push(like(products.productId, `%${productId}%`));
    if (search) conditions.push(or(like(products.itemCode, `%${search}%`), like(products.productName, `%${search}%`))!);
    if (imageProcessStatus === "all_processed") {
      conditions.push(sql`${products.imageCount} > 0 and ${products.processedImageCount} >= ${products.imageCount}`);
    } else if (imageProcessStatus === "processing") {
      conditions.push(sql`${products.processingImageCount} > 0`);
    } else if (imageProcessStatus === "not_all_processed") {
      conditions.push(eq(products.manuallyProcessed, false), sql`${products.imageCount} > 0 and ${products.processedImageCount} < ${products.imageCount}`);
    } else if (imageProcessStatus === "none_processed") {
      conditions.push(eq(products.manuallyProcessed, false), sql`${products.imageCount} > 0 and ${products.processedImageCount} = 0`);
    } else if (imageProcessStatus === "manually_processed") {
      conditions.push(eq(products.manuallyProcessed, true));
    }

    const where = conditions.length ? and(...conditions) : undefined;
    const totalRow = db
      .select({ c: countFn() })
      .from(products)
      .where(where ?? sql`1=1`)
      .get();
    const total = totalRow?.c ?? 0;
    const rows = db
      .select()
      .from(products)
      .where(where ?? sql`1=1`)
      .orderBy(desc(products.id))
      .limit(perPage)
      .offset((page - 1) * perPage)
      .all();
    return ok({ items: rows.map((p) => productToDict(p)), total, page, per_page: perPage });
  });

  ipcMain.handle("products:delete", async (_e, id): Promise<ApiResult> => {
    const db = getDb();
    db.delete(products).where(eq(products.id, id)).run();
    return ok({ deleted_id: id });
  });

  ipcMain.handle("products:batchDelete", async (_e, payload): Promise<ApiResult> => {
    const ids = intList(payload?.product_ids);
    if (!ids.length) return fail("请选择商品");
    const db = getDb();
    const r = db.delete(products).where(inArray(products.id, ids)).run();
    return ok({ deleted: r.changes });
  });

  ipcMain.handle("products:updateFlags", async (_e, id, payload): Promise<ApiResult> => {
    const db = getDb();
    const product = db.select().from(products).where(eq(products.id, id)).get();
    if (!product) return fail("商品不存在");
    const patch: Record<string, unknown> = { updatedAt: utcNow() };
    const changed: string[] = [];
    if (payload?.disable_flip !== undefined) {
      patch.disableFlip = Boolean(payload.disable_flip);
      changed.push("disable_flip");
    }
    if (payload?.manually_processed !== undefined) {
      const mp = Boolean(payload.manually_processed);
      patch.manuallyProcessed = mp;
      patch.manuallyProcessedAt = mp ? utcNow() : null;
      changed.push("manually_processed");
    }
    if (!changed.length) return fail("没有可更新的商品标记");
    db.update(products).set(patch).where(eq(products.id, id)).run();
    const updated = db.select().from(products).where(eq(products.id, id)).get()!;
    syncImageCounts(updated);
    return ok({ product: productToDict(updated, true) });
  });

  ipcMain.handle("products:batchFlags", async (_e, payload): Promise<ApiResult> => {
    const ids = intList(payload?.product_ids);
    const patch: Record<string, unknown> = {};
    if (payload?.disable_flip !== undefined) patch.disableFlip = Boolean(payload.disable_flip);
    if (!ids.length || !Object.keys(patch).length) return fail("参数不完整");
    const db = getDb();
    const r = db.update(products).set(patch).where(inArray(products.id, ids)).run();
    return ok({ updated: r.changes });
  });

  ipcMain.handle("products:manualSync", async (_e, payload): Promise<ApiResult> => {
    const accountIds = intList(payload?.account_ids);
    const inputType = String(payload?.input_type ?? "sku");
    const values = String(payload?.values ?? "");
    if (!["sku", "product_id", "url"].includes(inputType)) return fail("input_type 只能是 sku、product_id、url");
    if (!values.trim()) return fail("请输入商品 URL、商品ID 或 itemCode");
    try {
      const result = await syncManualProducts(accountIds, inputType, values);
      return ok({ result });
    } catch (err) {
      return fail(String((err as Error).message ?? err));
    }
  });

  ipcMain.handle("products:fullSync", async (_e, payload): Promise<ApiResult> => {
    const accountIds = intList(payload?.account_ids);
    const full = Boolean(payload?.full);
    if (!accountIds.length) return fail("请选择账号");
    try {
      const r = await syncAllProductsForAccounts(accountIds, { full });
      const label = full ? "全量同步" : "同步新收藏";
      const durationS = Math.round(r.durationMs / 100) / 10;
      return ok({ message: `${label}完成，共 ${r.totalSynced} 个商品（新增 ${r.totalNew}），耗时 ${durationS} 秒` });
    } catch (err) {
      return fail(`同步失败: ${err}`);
    }
  });

  ipcMain.handle("products:batchPriceInventorySync", async (_e, payload): Promise<ApiResult> => {
    const ids = intList(payload?.product_ids);
    if (!ids.length) return fail("请选择商品");
    try {
      const result = await syncPriceInventoryCache({ productIds: ids });
      return ok({ result });
    } catch (err) {
      return fail(`同步库存价格失败: ${err}`);
    }
  });

  ipcMain.handle("products:batchSkuInfoSync", async (_e, payload): Promise<ApiResult> => {
    const ids = intList(payload?.product_ids);
    if (!ids.length) return fail("请选择商品");
    try {
      const result = await syncProductSkuInfo({ productIds: ids });
      return ok({ result });
    } catch (err) {
      return fail(`获取SKU失败: ${err}`);
    }
  });

  ipcMain.handle("products:getImages", async (_e, id): Promise<ApiResult> => {
    const db = getDb();
    const product = db.select().from(products).where(eq(products.id, id)).get();
    if (!product) return fail("商品不存在");
    const raw = safeJsonParse<Record<string, unknown>>(product.rawDetailJson, {});
    const imageUrls = imageUrlsFromProduct(raw);
    const imageMap = ensureImageProcessMap(safeJsonParse(product.imageProcessMapJson, { version: 1, items: [] }), imageUrls);
    const counts = countImageStatuses(imageMap);
    db.update(products)
      .set({
        imageProcessMapJson: JSON.stringify(imageMap),
        processedImageCount: Math.min(counts.processed, imageUrls.length),
        processingImageCount: Math.min(counts.processing, imageUrls.length),
        updatedAt: utcNow(),
      })
      .where(eq(products.id, id))
      .run();
    const updated = db.select().from(products).where(eq(products.id, id)).get()!;
    return ok({ product: productToDict(updated, true), image_map: withFileUrls(imageMap as unknown as Record<string, unknown>) });
  });

  ipcMain.handle("products:uploadLocalImages", async (_e, payload): Promise<ApiResult> => {
    const accountId = Number(payload?.account_id);
    if (!accountId) return fail("请选择账号");
    try {
      const product = await createLocalImageProduct({
        accountId,
        itemCode: String(payload?.item_code ?? ""),
        productName: String(payload?.product_name ?? ""),
        files: (payload?.files ?? []) as { name: string; data: Buffer }[],
      });
      const raw = safeJsonParse<Record<string, unknown>>(product.rawDetailJson, {});
      const imageUrls = imageUrlsFromProduct(raw);
      const imageMap = ensureImageProcessMap(safeJsonParse(product.imageProcessMapJson, { version: 1, items: [] }), imageUrls);
      const counts = countImageStatuses(imageMap);
      const db = getDb();
      db.update(products)
        .set({
          imageProcessMapJson: JSON.stringify(imageMap),
          processedImageCount: Math.min(counts.processed, imageUrls.length),
          processingImageCount: Math.min(counts.processing, imageUrls.length),
          updatedAt: utcNow(),
        })
        .where(eq(products.id, product.id!))
        .run();
      const updated = db.select().from(products).where(eq(products.id, product.id!)).get()!;
      return ok({ product: productToDict(updated, true), image_map: withFileUrls(imageMap as unknown as Record<string, unknown>) });
    } catch (err) {
      return fail(String((err as Error).message ?? err));
    }
  });

  ipcMain.handle("favorites:cancelAll", async (_e, payload): Promise<ApiResult> => {
    const ids = intList(payload?.account_ids);
    if (!ids.length) return fail("请选择账号");
    try {
      const result = await cancelAllFavorites(ids);
      return ok({ result });
    } catch (err) {
      return fail(String((err as Error).message ?? err));
    }
  });

  // ---------- 图片生成 ----------
  ipcMain.handle("images:generate", async (_e, payload): Promise<ApiResult> => {
    const ids = intList(payload?.product_ids);
    if (!ids.length) return fail("请选择商品");
    const flipSource = Boolean(payload?.flip_source);
    const submitted = await premarkImagesProcessing(ids, { includeProcessed: false, skipManualProcessed: true });
    const job = startJob("generate_images", (progress) =>
      generateProductImages(ids, { indicesByProduct: submitted, skipProcessed: true, flipSource, allowProcessingItems: true, progress }),
    );
    return ok({ job: jobToDict(job) });
  });

  ipcMain.handle("images:regenerate", async (_e, payload): Promise<ApiResult> => {
    const ids = intList(payload?.product_ids);
    if (!ids.length) return fail("请选择商品");
    const submitted = await premarkImagesProcessing(ids, { includeProcessed: true, skipManualProcessed: false });
    const job = startJob("regenerate_images", (progress) =>
      generateProductImages(ids, { indicesByProduct: submitted, allowProcessingItems: true, progress }),
    );
    return ok({ job: jobToDict(job) });
  });

  ipcMain.handle("products:regenerateImages", async (_e, id, payload): Promise<ApiResult> => {
    const indices = intList(payload?.indices);
    if (!indices.length) return fail("请选择要重新生成的图片");
    const db = getDb();
    const product = db.select().from(products).where(eq(products.id, id)).get();
    if (!product) return fail("商品不存在");
    const raw = safeJsonParse<Record<string, unknown>>(product.rawDetailJson, {});
    const imageUrls = imageUrlsFromProduct(raw);
    const imageMap = ensureImageProcessMap(safeJsonParse(product.imageProcessMapJson, { version: 1, items: [] }), imageUrls);
    const stuck = indices.filter((i) => {
      if (i >= imageUrls.length) return false;
      const item = imageMap.items.find((it) => it.index === i);
      return item?.status === "processing";
    }).sort((a, b) => a - b);
    if (stuck.length) {
      const labels = stuck.map((i) => String(i + 1)).join("、");
      return fail(`第 ${labels} 张图正在处理中，请等待当前任务完成后再重试`);
    }
    const job = startJob("regenerate_images", (progress) =>
      generateProductImages([id], { indicesByProduct: { [id]: indices }, progress }),
    );
    return ok({ job: jobToDict(job) });
  });

  ipcMain.handle("products:approveImage", async (_e, id, payload): Promise<ApiResult> => {
    try {
      const { product, deletedFiles } = await approveProductImage(id, {
        index: Number(payload?.index ?? 0),
        selectedPath: payload?.selected_path,
      });
      const raw = safeJsonParse<Record<string, unknown>>(product.rawDetailJson, {});
      const imageUrls = imageUrlsFromProduct(raw);
      const imageMap = ensureImageProcessMap(safeJsonParse(product.imageProcessMapJson, { version: 1, items: [] }), imageUrls);
      return ok({ product: productToDict(product, true), image_map: withFileUrls(imageMap as unknown as Record<string, unknown>), deleted_files: deletedFiles });
    } catch (err) {
      return fail(String((err as Error).message ?? err));
    }
  });

  ipcMain.handle("products:rejectImage", async (_e, id, payload): Promise<ApiResult> => {
    try {
      const { product, removedPath, fileDeleted } = await rejectProductImage(id, {
        index: Number(payload?.index ?? 0),
        selectedPath: payload?.selected_path,
      });
      const raw = safeJsonParse<Record<string, unknown>>(product.rawDetailJson, {});
      const imageUrls = imageUrlsFromProduct(raw);
      const imageMap = ensureImageProcessMap(safeJsonParse(product.imageProcessMapJson, { version: 1, items: [] }), imageUrls);
      return ok({ product: productToDict(product, true), image_map: withFileUrls(imageMap as unknown as Record<string, unknown>), deleted_path: removedPath, file_deleted: fileDeleted });
    } catch (err) {
      return fail(String((err as Error).message ?? err));
    }
  });

  // ---------- WPS ----------
  ipcMain.handle("products:wpsSync", async (_e, id): Promise<ApiResult> => {
    try {
      const result = await syncProductToWpsCloudDoc(id);
      const db = getDb();
      const product = db.select().from(products).where(eq(products.id, id)).get()!;
      return ok({ result, product: productToDict(product, true) });
    } catch (err) {
      return fail(`同步云文档失败：${err}`);
    }
  });

  ipcMain.handle("products:batchWpsSync", async (_e, payload): Promise<ApiResult> => {
    const ids = intList(payload?.product_ids);
    if (!ids.length) return fail("请选择商品");
    try {
      const result = await syncProductsToWpsCloudDoc(ids);
      return ok({ result });
    } catch (err) {
      return fail(`同步云文档失败：${err}`);
    }
  });

  // ---------- 任务 ----------
  ipcMain.handle("jobs:list", async (): Promise<ApiResult> => {
    const db = getDb();
    const list = db.select().from(jobs).orderBy(desc(jobs.id)).limit(50).all();
    return ok({ items: list.map(jobToDict) });
  });

  ipcMain.handle("jobs:get", async (_e, id): Promise<ApiResult> => {
    const db = getDb();
    const job = db.select().from(jobs).where(eq(jobs.id, id)).get();
    if (!job) return fail("任务不存在");
    return ok({ item: jobToDict(job) });
  });

  // ---------- Studio ----------
  ipcMain.handle("studio:open", async (): Promise<ApiResult> => {
    try {
      const { getStudioUrl } = await import("../studio/studioServer");
      const url = getStudioUrl();
      const win = new BrowserWindow({
        width: 1400,
        height: 900,
        title: "亚马逊图片工作台",
        webPreferences: { contextIsolation: true },
      });
      await win.loadURL(url);
      return ok({ opened: true });
    } catch (err) {
      return fail(`打开工作台失败：${err}`);
    }
  });
}

/** 预标记图片为 processing 状态（生成前）。 */
async function premarkImagesProcessing(
  productIds: number[],
  opts: { includeProcessed: boolean; skipManualProcessed: boolean },
): Promise<Record<number, number[]>> {
  const db = getDb();
  const submitted: Record<number, number[]> = {};
  const list = db.select().from(products).where(inArray(products.id, productIds)).all();
  for (const product of list) {
    if (opts.skipManualProcessed && product.manuallyProcessed) continue;
    const raw = safeJsonParse<Record<string, unknown>>(product.rawDetailJson, {});
    const imageUrls = imageUrlsFromProduct(raw);
    if (!imageUrls.length) continue;
    let imageMap = ensureImageProcessMap(safeJsonParse(product.imageProcessMapJson, { version: 1, items: [] }), imageUrls);
    const indices: number[] = [];
    for (let index = 0; index < imageUrls.length; index++) {
      const item = imageMap.items.find((it) => it.index === index);
      if (item?.status === "processing") continue;
      if (!opts.includeProcessed && (item?.status === "generated" || item?.status === "approved")) continue;
      imageMap = markProcessing(imageMap, { index, originalUrl: imageUrls[index] ?? "" });
      indices.push(index);
    }
    if (indices.length) submitted[product.id!] = indices;
    const counts = countImageStatuses(imageMap);
    db.update(products)
      .set({
        imageProcessMapJson: JSON.stringify(imageMap),
        processedImageCount: Math.min(counts.processed, imageUrls.length),
        processingImageCount: Math.min(counts.processing, imageUrls.length),
        updatedAt: utcNow(),
      })
      .where(eq(products.id, product.id!))
      .run();
  }
  return submitted;
}
