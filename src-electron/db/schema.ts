/**
 * Drizzle ORM schema —— 对应原 Python SQLAlchemy 模型。
 *
 * 时间戳统一存 epoch 秒（integer），JSON 字段用 text 存储（SQLite）
 * 再在应用层 JSON.parse/stringify，与原项目 naive UTC+8 行为一致。
 */

import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** 账号表 */
export const accounts = sqliteTable(
  "accounts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    accountName: text("account_name").notNull(),
    appid: text("appid").notNull(),
    secret: text("secret").notNull(),
    cookie: text("cookie").notNull().default(""),
    csrfToken: text("csrf_token"),
    deviceId: text("device_id"),
    userAgent: text("user_agent"),
    screen: text("screen").default("1920x1080"),
    webBaseUrl: text("web_base_url").notNull(),
    openapiBaseUrl: text("openapi_base_url").notNull(),
    remark: text("remark"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    lastValidatedAt: integer("last_validated_at"),
    lastProductSyncedAt: integer("last_product_synced_at"),
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at")
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex("idx_accounts_appid").on(table.appid),
  ],
);

/** 商品表 */
export const products = sqliteTable(
  "products",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    productId: text("product_id"),
    itemCode: text("item_code").notNull(),
    productName: text("product_name"),
    rawDetailJson: text("raw_detail_json").notNull(),
    skuInfoJson: text("sku_info_json"),
    imageProcessMapJson: text("image_process_map_json"),
    imageCount: integer("image_count").notNull().default(0),
    processedImageCount: integer("processed_image_count").notNull().default(0),
    processingImageCount: integer("processing_image_count").notNull().default(0),
    priceInventoryJson: text("price_inventory_json"),
    priceInventorySyncedAt: integer("price_inventory_synced_at"),
    priceInventoryError: text("price_inventory_error"),
    disableFlip: integer("disable_flip", { mode: "boolean" }).notNull().default(false),
    hidden: integer("hidden", { mode: "boolean" }).notNull().default(false),
    manuallyProcessed: integer("manually_processed", { mode: "boolean" }).notNull().default(false),
    manuallyProcessedAt: integer("manually_processed_at"),
    syncedAt: integer("synced_at")
      .notNull()
      .default(sql`(unixepoch())`),
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at")
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    index("idx_products_account_id").on(table.accountId),
    index("idx_products_product_id").on(table.productId),
    index("idx_products_item_code").on(table.itemCode),
    index("idx_products_product_name").on(table.productName),
    index("idx_products_hidden").on(table.hidden),
    // 唯一约束 (account_id, item_code)
    uniqueIndex("uq_products_account_item").on(table.accountId, table.itemCode),
  ],
);

/** 后台任务表 */
export const jobs = sqliteTable(
  "jobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    jobType: text("job_type").notNull(),
    status: text("status").notNull().default("pending"),
    total: integer("total").notNull().default(0),
    processed: integer("processed").notNull().default(0),
    successCount: integer("success_count").notNull().default(0),
    failCount: integer("fail_count").notNull().default(0),
    message: text("message"),
    logs: text("logs"),
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at")
      .notNull()
      .default(sql`(unixepoch())`),
    finishedAt: integer("finished_at"),
  },
  (table) => [
    index("idx_jobs_job_type").on(table.jobType),
    index("idx_jobs_status").on(table.status),
  ],
);

/** item_code ↔ product_id 缓存表（原 item_code_product_id_cache） */
export const itemCodeProductIdCache = sqliteTable(
  "item_code_product_id_cache",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    itemCode: text("item_code").notNull(),
    productId: text("product_id"),
    productName: text("product_name"),
    source: text("source").default("anonymous_product_search"),
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at")
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex("idx_cache_item_code").on(table.itemCode),
    index("idx_cache_product_id").on(table.productId),
    index("idx_cache_updated_at").on(table.updatedAt),
  ],
);

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
export type ItemCodeProductIdCache = typeof itemCodeProductIdCache.$inferSelect;
