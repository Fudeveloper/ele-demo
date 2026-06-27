/**
 * 序列化 / 派生字段 —— 对应 `models.py` 的 to_dict 与各 _read 辅助函数。
 */

import type { Account, Product } from "../db/schema";
import { safeJsonParse, utcNowStr } from "../lib/util";
import { withGigaOssSize } from "../lib/storage/oss";
import type { ImageProcessMap } from "../lib/image/imageMap";
import { countImageStatuses } from "../lib/image/imageMap";

const PRICE_INVENTORY_SYNC_CHUNK_SIZE = 200;

export interface SkuInfo {
  index: number;
  name: string;
  item_code: string;
  product_id: string;
  image: string;
  images: string[];
}

export interface PriceInventoryData {
  price?: {
    price?: string;
    shippingFee?: string;
    totalPrice?: string;
  } | null | undefined;
  inventory?: {
    sellerInventoryInfo?: { sellerAvailableInventory?: unknown } | null;
  } | null | undefined;
}

/** 读取商品的图片 URL（mainImageUrl + imageUrls），归一化为 900x900。 */
export function readImageUrls(rawDetail: Record<string, unknown> | null): string[] {
  if (!rawDetail || typeof rawDetail !== "object") return [];
  const result: string[] = [];
  const main = rawDetail.mainImageUrl;
  if (typeof main === "string" && main.trim()) result.push(main.trim());
  const urls = rawDetail.imageUrls;
  if (Array.isArray(urls)) {
    for (const u of urls) {
      if (typeof u === "string" && u.trim()) result.push(u.trim());
    }
  }
  const normalized = result.map((u) => withGigaOssSize(u));
  return Array.from(new Set(normalized));
}

/** 是否单 SKU 商品（无 associateProductList）。 */
export function isSingleProduct(productData: Record<string, unknown> | null): boolean {
  if (!productData || typeof productData !== "object") return true;
  if (productData.source === "local_upload") return true;
  const assoc = productData.associateProductList;
  return !Array.isArray(assoc) || assoc.length === 0;
}

export function isLocalProduct(rawDetail: Record<string, unknown> | null): boolean {
  return Boolean(rawDetail && rawDetail.source === "local_upload");
}

/** 读取 image_process_map_json。 */
export function readImageMap(map: string | null): ImageProcessMap {
  return safeJsonParse<ImageProcessMap>(map, { version: 1, items: [] });
}

/** 读取 sku_info_json。 */
export function readSkuInfo(skuInfoJson: string | null): SkuInfo[] {
  const v = safeJsonParse<unknown>(skuInfoJson, []);
  return Array.isArray(v) ? (v as SkuInfo[]) : [];
}

/** 从 price_inventory_json 读取 {price, inventory}。 */
export function cachedPriceInventory(piJson: string | null): PriceInventoryData {
  const v = safeJsonParse<PriceInventoryData>(piJson, { price: null, inventory: null });
  if (!v || typeof v !== "object") return { price: null, inventory: null };
  return {
    price: v.price ?? null,
    inventory: v.inventory ?? null,
  };
}

function mask(value: string, keep = 8): string {
  if (!value) return "";
  if (value.length <= keep * 2) return "***";
  return `${value.slice(0, keep)}...${value.slice(-keep)}`;
}

function fmtDate(seconds: number | null | undefined): string {
  if (!seconds) return "";
  const d = new Date(seconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** account.to_dict()。 */
export function accountToDict(account: Account, includeSecret = false): Record<string, unknown> {
  return {
    id: account.id,
    account_name: account.accountName,
    appid: account.appid,
    secret: includeSecret ? account.secret : mask(account.secret),
    cookie: includeSecret ? account.cookie : mask(account.cookie),
    csrf_token: account.csrfToken ?? "",
    device_id: account.deviceId ?? "",
    user_agent: account.userAgent ?? "",
    screen: account.screen ?? "1920x1080",
    web_base_url: account.webBaseUrl,
    openapi_base_url: account.openapiBaseUrl,
    remark: account.remark ?? "",
    enabled: Boolean(account.enabled),
    last_validated_at: fmtDate(account.lastValidatedAt),
    last_product_synced_at: fmtDate(account.lastProductSyncedAt),
    created_at: fmtDate(account.createdAt),
    updated_at: fmtDate(account.updatedAt),
  };
}

/** product.to_dict() 派生字段。 */
export function productToDict(product: Product, includeRaw = false): Record<string, unknown> {
  const raw = safeJsonParse<Record<string, unknown>>(product.rawDetailJson, {});
  const imageUrls = readImageUrls(raw);
  const imageMap = readImageMap(product.imageProcessMapJson);
  const counts = countImageStatuses(imageMap);
  const imageCount = imageUrls.length;
  const processedImageCount = Math.min(counts.processed, imageCount);
  const processingImageCount = Math.min(counts.processing, imageCount);
  // last_processed_at = 最大 started_at 字符串
  let lastProcessedAt = "";
  for (const item of imageMap.items) {
    if (typeof item.started_at === "string" && item.started_at > lastProcessedAt) {
      lastProcessedAt = item.started_at;
    }
  }
  const single = isSingleProduct(raw);
  const skuInfo = readSkuInfo(product.skuInfoJson);
  const firstImageUrl = imageUrls.length ? imageUrls[0] : "";
  const priceInventory = cachedPriceInventory(product.priceInventoryJson);
  const priceData = priceInventory.price ?? null;
  const inventoryData = priceInventory.inventory ?? null;

  const dict: Record<string, unknown> = {
    id: product.id,
    account_id: product.accountId,
    product_id: product.productId ?? "",
    item_code: product.itemCode,
    product_name: product.productName ?? "",
    image_count: imageCount,
    processed_image_count: processedImageCount,
    processing_image_count: processingImageCount,
    last_processed_at: lastProcessedAt,
    is_single: single,
    sku_info: skuInfo,
    sku_count: skuInfo.length,
    first_image_url: firstImageUrl,
    image_process_text: `${processedImageCount}/${imageCount}`,
    price_inventory_price: priceData?.price ?? "",
    price_inventory_total_price: priceData?.totalPrice ?? "",
    price_inventory_stock: inventoryData?.sellerInventoryInfo?.sellerAvailableInventory != null
      ? String(inventoryData.sellerInventoryInfo.sellerAvailableInventory)
      : "",
    price_inventory_failed: Boolean(product.priceInventoryError),
    price_inventory_synced_at: fmtDate(product.priceInventorySyncedAt),
    disable_flip: Boolean(product.disableFlip),
    hidden: Boolean(product.hidden),
    manually_processed: Boolean(product.manuallyProcessed),
    manually_processed_at: fmtDate(product.manuallyProcessedAt),
    synced_at: fmtDate(product.syncedAt),
    created_at: fmtDate(product.createdAt),
    updated_at: fmtDate(product.updatedAt),
    image_process_map_json: imageMap,
  };
  if (includeRaw) {
    dict.raw_detail_json = raw;
    dict.image_urls = imageUrls;
  }
  return dict;
}

/** 重算商品的 image_count/processed/processing 列。 */
export function syncImageCounts(product: Product): void {
  const raw = safeJsonParse<Record<string, unknown>>(product.rawDetailJson, {});
  const imageUrls = readImageUrls(raw);
  const imageMap = readImageMap(product.imageProcessMapJson);
  const counts = countImageStatuses(imageMap);
  product.imageCount = imageUrls.length;
  product.processedImageCount = Math.min(counts.processed, imageUrls.length);
  product.processingImageCount = Math.min(counts.processing, imageUrls.length);
}

export { PRICE_INVENTORY_SYNC_CHUNK_SIZE, utcNowStr, fmtDate };
