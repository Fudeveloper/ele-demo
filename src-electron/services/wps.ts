/**
 * WPS 云文档同步服务 —— 移植自 services.py 的 WPS 相关函数。
 */

import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { accounts, products, type Product } from "../db/schema";
import { getConfig } from "../config";
import { firstString, utcNowStr } from "../lib/util";
import { httpRequest, httpRequestJson } from "../lib/http";
import { imageUrlsFromProduct, ensureImageProcessMap, countImageStatuses } from "../lib/image/imageMap";
import { safeJsonParse } from "../lib/util";
import { cachedPriceInventory, readImageUrls, isSingleProduct } from "./serialization";
import { normalizedProductSkuInfo } from "./sku";
import { refreshPriceInventoryCacheForCloudDoc } from "./priceInventory";
import { publicImageUrl } from "./images";
import wpsFieldsRaw from "../assets/wps_fields.json";

type FieldMap = Record<string, string>;
const FIELD_MAP = wpsFieldsRaw as FieldMap;

interface WpsConfig {
  webhookUrl: string;
  airscriptToken: string;
  fieldNames: FieldMap;
}

function wpsConfig(): WpsConfig {
  const cfg = getConfig();
  if (!cfg.wpsWebhookUrl) throw new Error("WPS_WEBHOOK_URL 未配置");
  if (!cfg.wpsAirscriptToken) throw new Error("WPS_AIRSCRIPT_TOKEN 未配置");
  return { webhookUrl: cfg.wpsWebhookUrl, airscriptToken: cfg.wpsAirscriptToken, fieldNames: FIELD_MAP };
}

function associateItemCodes(product: Product): string[] {
  const raw = safeJsonParse<Record<string, unknown>>(product.rawDetailJson, {});
  const list = raw.associateProductList;
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item === "string") {
      if (item.trim()) out.push(item.trim());
    } else if (item && typeof item === "object") {
      const code = firstString(item as Record<string, unknown>, "itemCode", "sku");
      if (code) out.push(code);
    } else {
      const s = String(item).trim();
      if (s) out.push(s);
    }
  }
  return out;
}

function cloudDocImageProcessStatus(product: Product, imageMap: ReturnType<typeof ensureImageProcessMap>, imageUrls: string[]): [string, string] {
  const total = imageUrls.length;
  const counts = countImageStatuses(imageMap);
  const processed = Math.min(counts.processed, total);
  const processing = Math.min(counts.processing, total);
  const progressText = `${processed}/${total}`;
  if (product.manuallyProcessed) return ["手动处理", progressText];
  if (processing) return ["处理中", progressText];
  if (total && processed >= total) return ["已完成", progressText];
  if (processed) return ["部分完成", progressText];
  return ["未处理", progressText];
}

function flattenValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.filter((v) => v !== null && v !== undefined).map((v) => String(v)).join("\n");
  if (typeof value === "object") return null;
  return value;
}

function resolveFieldValue(values: Record<string, unknown>, key: string): unknown {
  if (key.includes(".")) {
    const parts = key.split(".");
    let cur: unknown = values;
    for (const p of parts) {
      if (cur && typeof cur === "object") cur = (cur as Record<string, unknown>)[p];
      else return null;
    }
    return flattenValue(cur);
  }
  return flattenValue(values[key]);
}

function wpsFieldAliases(key: string, columnHeader: string): string[] {
  if (key !== "skuName") return [];
  const candidates = ["SKU名字", "sku名字", "SKU 名字", "sku 名字", "SKU名称", "sku名称"];
  return candidates.filter((c) => c && c !== columnHeader);
}

/** 构造商品的 WPS 字段映射。 */
export async function buildWpsProductFields(
  product: Product,
  fieldNames: FieldMap,
  opts: { priceData?: Record<string, unknown> | null; inventoryData?: Record<string, unknown> | null },
): Promise<Record<string, unknown>> {
  const db = getDb();
  const raw = safeJsonParse<Record<string, unknown>>(product.rawDetailJson, {});
  const imageUrls = readImageUrls(raw);
  const imageMap = ensureImageProcessMap(safeJsonParse(product.imageProcessMapJson, { version: 1, items: [] }), imageUrls);

  // 选中图片的公开 URL
  const exportUrls: string[] = [];
  const itemByIndex = new Map<number, (typeof imageMap.items)[number]>();
  for (const item of imageMap.items) itemByIndex.set(item.index, item);
  for (let idx = 0; idx < imageUrls.length; idx++) {
    const item = itemByIndex.get(idx);
    const url = item?.selected_path || imageUrls[idx] || "";
    exportUrls.push(await publicImageUrl(url, product.itemCode));
  }
  const latestImageValue = exportUrls.length ? `=IMAGE("${exportUrls[0] ?? ""}")` : "";
  const latestImageUrl = exportUrls.length ? (exportUrls[0] ?? "") : "";
  const originalImageValue = exportUrls.join("\n");

  const [status, progressText] = cloudDocImageProcessStatus(product, imageMap, imageUrls);

  // SKU
  let skuNameValue = "";
  let skuImageValue = "";
  if (isSingleProduct(raw)) {
    skuNameValue = "As One";
    skuImageValue = latestImageUrl;
  } else {
    const skuInfo = normalizedProductSkuInfo(product) as Array<Record<string, unknown>>;
    const mySku = product.productId ? skuInfo.find((s) => String(s.product_id) === String(product.productId)) : skuInfo[0];
    if (mySku) {
      skuNameValue = String(mySku.name ?? "");
      if (mySku.image) skuImageValue = await publicImageUrl(String(mySku.image), product.itemCode);
    }
  }

  const account = db.select().from(accounts).where(eq(accounts.id, product.accountId)).get();

  const weightUnit = (raw.weightUnit as string) || "lb";
  let packageCount = 1;
  let lengthCm = raw.lengthCm as number | undefined;
  let widthCm = raw.widthCm as number | undefined;
  let heightCm = raw.heightCm as number | undefined;
  let packageWeight = "";
  let skuNameFallback = "";

  const comboFlag = raw.comboFlag;
  const comboList = Array.isArray(raw.comboInfo) ? (raw.comboInfo as Array<Record<string, unknown>>).filter((c) => c && typeof c === "object") : [];
  if (comboFlag) {
    packageCount = comboList.length || 1;
    if (comboList.length) {
      lengthCm = Math.max(...comboList.map((c) => Number(c.lengthCm || 0)));
      widthCm = Math.max(...comboList.map((c) => Number(c.widthCm || 0)));
      heightCm = Math.max(...comboList.map((c) => Number(c.heightCm || 0)));
      const maxWeight = Math.max(...comboList.map((c) => Number(c.weight || 0)));
      packageWeight = `${maxWeight} ${weightUnit}`;
      skuNameFallback = comboList.map((c) => firstString(c, "itemCode", "sku")).filter(Boolean).join("\n");
    }
  } else {
    const w = raw.weight;
    packageWeight = w !== undefined && w !== null ? `${w} ${weightUnit}` : "";
  }

  let goodsType = "";
  if (raw.overSizeFlag) goodsType = "LTL";
  else if (comboFlag) goodsType = "combo";

  const values: Record<string, unknown> = {
    item_code: product.itemCode,
    product_name: product.productName ?? "",
    account_name: account?.accountName ?? "",
    product_id: product.productId ?? "",
    latest_image: latestImageValue,
    original_image: originalImageValue,
    image_count: imageUrls.length,
    image_process: progressText,
    status,
    disable_flip: product.disableFlip ? "是" : "否",
    manual_processed: product.manuallyProcessed ? "是" : "否",
    synced_at: utcNowStr(),
    updated_at: product.updatedAt ? utcNowStr() : "",
    productLink: `https://www.gigab2b.com/index.php?route=product/search&search=${encodeURIComponent(product.itemCode)}&search_source=0&search_dimension=1`,
    category: raw.category,
    characteristics: raw.characteristics,
    description: raw.description,
    unAvailablePlatform: raw.unAvailablePlatform,
    fileUrls: raw.fileUrls,
    certificationList: raw.certificationList,
    productVideoUrl: raw.productVideoUrl,
    firstArrivalDate: raw.firstArrivalDate,
    downloadCount: raw.downloadCount,
    sellerInfo: raw.sellerInfo,
    lengthCm,
    widthCm,
    heightCm,
    packageWeight,
    packageCount,
    goodsType,
    skuName: skuNameValue || skuNameFallback || (raw.sku as string) || "",
    skuImage: skuImageValue || latestImageUrl,
  };

  // 合并价格/库存
  const priceData = opts.priceData ?? null;
  const inventoryData = opts.inventoryData ?? null;
  if (priceData) {
    if (priceData.price !== undefined) values.price = priceData.price;
    if (priceData.shippingFee !== undefined) values.shippingFee = priceData.shippingFee;
    if (priceData.totalPrice !== undefined) values.totalPrice = priceData.totalPrice;
  }
  if (inventoryData) {
    values.sellerInventoryInfo = inventoryData.sellerInventoryInfo;
  }
  // 合并 raw 顶层未覆盖字段
  for (const [k, v] of Object.entries(raw)) {
    if (!(k in values)) values[k] = v;
  }

  // 构造 fields
  const fields: Record<string, unknown> = {};
  for (const [key, columnHeader] of Object.entries(fieldNames)) {
    if (!columnHeader || columnHeader.startsWith("_")) continue;
    const value = resolveFieldValue(values, key);
    if (value === null || value === undefined) continue;
    fields[columnHeader] = value;
    for (const alias of wpsFieldAliases(key, columnHeader)) {
      if (!(alias in fields)) fields[alias] = value;
    }
  }
  return fields;
}

async function postWpsWebhook(cfg: WpsConfig, fields: Record<string, unknown>, itemCode: string, sheetName: string): Promise<void> {
  const payload = {
    Context: {
      argv: {
        action: "sync",
        item_code: itemCode.trim(),
        item_code_field: cfg.fieldNames.item_code,
        sheet_name: sheetName,
        fields,
      },
    },
  };
  await httpRequestJson(`${cfg.webhookUrl}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "AirScript-Token": cfg.airscriptToken },
    body: JSON.stringify(payload),
    timeoutMs: 60000,
  });
}

export interface WpsSyncResult {
  action: string;
  record_id: string;
  fields: Record<string, unknown>;
}

export async function syncProductToWpsCloudDoc(productId: number, refreshPriceInventory = true): Promise<WpsSyncResult> {
  const db = getDb();
  const product = db.select().from(products).where(eq(products.id, productId)).get();
  if (!product) throw new Error("product not found");
  const cfg = wpsConfig();
  const raw = safeJsonParse<Record<string, unknown>>(product.rawDetailJson, {});

  const priceInventory = refreshPriceInventory
    ? await refreshPriceInventoryCacheForCloudDoc(product)
    : cachedPriceInventory(product.priceInventoryJson);

  const fields = await buildWpsProductFields(product, cfg.fieldNames, {
    priceData: priceInventory.price ?? null,
    inventoryData: priceInventory.inventory ?? null,
  });

  const isLocal = raw.source === "local_upload";
  const sheetName = isLocal ? "本地上传" : "默认";

  const payload = {
    Context: {
      argv: {
        action: "sync",
        item_code: product.itemCode.trim(),
        item_code_field: cfg.fieldNames.item_code,
        sheet_name: sheetName,
        fields,
      },
    },
  };
  const resp = await httpRequestJson<Record<string, unknown>>(cfg.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "AirScript-Token": cfg.airscriptToken },
    body: JSON.stringify(payload),
    timeoutMs: 60000,
  });
  if (!resp || typeof resp !== "object") throw new Error("AirScript 同步失败: 响应非对象");
  if (resp.error) throw new Error(`AirScript 同步失败: ${resp.error}`);
  const dataInner = (resp.data as Record<string, unknown>) ?? {};
  const result = (dataInner.result as Record<string, unknown>) ?? resp;
  if (result.status !== "success") {
    throw new Error(`AirScript 同步失败: ${result.msg ?? JSON.stringify(resp)}`);
  }
  const action = (result.action as string) || "updated";
  const row = (result.row as number) || 0;

  // 子 SKU 行
  const assocCodes = associateItemCodes(product);
  for (const code of assocCodes) {
    if (code === product.itemCode) continue;
    const subFields = await buildSubSkuFields(cfg.fieldNames, product, code);
    await postWpsWebhook(cfg, subFields, code, sheetName);
  }

  return { action, record_id: String(row), fields };
}

async function buildSubSkuFields(fieldNames: FieldMap, product: Product, assocItemCode: string): Promise<Record<string, unknown>> {
  const skuInfo = normalizedProductSkuInfo(product) as Array<Record<string, unknown>>;
  const matched = skuInfo.find((s) => String(s.item_code) === assocItemCode);
  const skuName = matched?.name ? String(matched.name) : "";
  const skuImage = matched?.image ? await publicImageUrl(String(matched.image), product.itemCode) : "";
  const values: Record<string, unknown> = {
    item_code: assocItemCode,
    skuName,
    skuImage,
    updated_at: product.updatedAt ? utcNowStr() : "",
  };
  const fields: Record<string, unknown> = {};
  for (const [key, columnHeader] of Object.entries(fieldNames)) {
    if (!columnHeader || columnHeader.startsWith("_")) continue;
    const value = resolveFieldValue(values, key);
    if (value === null || value === undefined) continue;
    fields[columnHeader] = value;
  }
  return fields;
}

export async function syncProductsToWpsCloudDoc(productIds: number[]): Promise<{ total: number; success: number; fail: number }> {
  let success = 0;
  let fail = 0;
  for (const pid of productIds) {
    try {
      await syncProductToWpsCloudDoc(pid);
      success++;
    } catch {
      fail++;
    }
  }
  return { total: productIds.length, success, fail };
}

void httpRequest;
void imageUrlsFromProduct;
