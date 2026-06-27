import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { app } from "electron";
import { mkdirSync } from "node:fs";
import { eq, inArray, sql } from "drizzle-orm";
import * as schema from "./schema";
import { getConfig } from "../config";

type DB = BetterSQLite3Database<typeof schema>;

let dbInstance: DB | null = null;
let rawSqlite: Database.Database | null = null;

function shouldLogSql(): boolean {
  const flag = process.env.DRIZZLE_LOG?.toLowerCase();
  if (flag === "false" || flag === "0") return false;
  return true;
}

/**
 * 初始化数据库（SQLite）。
 *
 * 数据库文件存放于 `app.getPath('userData')/app.db`，首次运行时创建。
 * 表结构通过内联 SQL 建表（与 db/schema.ts 保持一致）。
 * 时间戳统一 epoch 秒；JSON 字段以 text 存储。
 */
export function initDb() {
  if (dbInstance) return dbInstance;

  const userDataPath = app.getPath("userData");
  mkdirSync(userDataPath, { recursive: true });
  const dbPath = path.join(userDataPath, "app.db");

  const sqlite = new Database(dbPath);
  rawSqlite = sqlite;
  // WAL 模式提升并发读写性能
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  // 建表（若不存在）
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      account_name         TEXT    NOT NULL,
      appid                TEXT    NOT NULL,
      secret               TEXT    NOT NULL,
      cookie               TEXT    NOT NULL DEFAULT '',
      csrf_token           TEXT,
      device_id            TEXT,
      user_agent           TEXT,
      screen               TEXT    DEFAULT '1920x1080',
      web_base_url         TEXT    NOT NULL,
      openapi_base_url     TEXT    NOT NULL,
      remark               TEXT,
      enabled              INTEGER NOT NULL DEFAULT 1,
      last_validated_at    INTEGER,
      last_product_synced_at INTEGER,
      created_at           INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at           INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_appid ON accounts(appid);

    CREATE TABLE IF NOT EXISTS products (
      id                         INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id                 INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      product_id                 TEXT,
      item_code                  TEXT    NOT NULL,
      product_name               TEXT,
      raw_detail_json            TEXT    NOT NULL,
      sku_info_json              TEXT,
      image_process_map_json     TEXT,
      image_count                INTEGER NOT NULL DEFAULT 0,
      processed_image_count      INTEGER NOT NULL DEFAULT 0,
      processing_image_count     INTEGER NOT NULL DEFAULT 0,
      price_inventory_json       TEXT,
      price_inventory_synced_at  INTEGER,
      price_inventory_error      TEXT,
      disable_flip               INTEGER NOT NULL DEFAULT 0,
      hidden                     INTEGER NOT NULL DEFAULT 0,
      manually_processed         INTEGER NOT NULL DEFAULT 0,
      manually_processed_at      INTEGER,
      synced_at                  INTEGER NOT NULL DEFAULT (unixepoch()),
      created_at                 INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at                 INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_products_account_id  ON products(account_id);
    CREATE INDEX IF NOT EXISTS idx_products_product_id  ON products(product_id);
    CREATE INDEX IF NOT EXISTS idx_products_item_code   ON products(item_code);
    CREATE INDEX IF NOT EXISTS idx_products_product_name ON products(product_name);
    CREATE INDEX IF NOT EXISTS idx_products_hidden      ON products(hidden);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_products_account_item ON products(account_id, item_code);

    CREATE TABLE IF NOT EXISTS jobs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      job_type      TEXT    NOT NULL,
      status        TEXT    NOT NULL DEFAULT 'pending',
      total         INTEGER NOT NULL DEFAULT 0,
      processed     INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0,
      fail_count    INTEGER NOT NULL DEFAULT 0,
      message       TEXT,
      logs          TEXT,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at    INTEGER NOT NULL DEFAULT (unixepoch()),
      finished_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_job_type ON jobs(job_type);
    CREATE INDEX IF NOT EXISTS idx_jobs_status   ON jobs(status);

    CREATE TABLE IF NOT EXISTS item_code_product_id_cache (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      item_code    TEXT    NOT NULL,
      product_id   TEXT,
      product_name TEXT,
      source       TEXT    DEFAULT 'anonymous_product_search',
      created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cache_item_code  ON item_code_product_id_cache(item_code);
    CREATE INDEX IF NOT EXISTS idx_cache_product_id        ON item_code_product_id_cache(product_id);
    CREATE INDEX IF NOT EXISTS idx_cache_updated_at        ON item_code_product_id_cache(updated_at);
  `);

  dbInstance = drizzle(sqlite, { schema, logger: shouldLogSql() });
  return dbInstance;
}

/** 启动维护：重置卡在 processing 的图片项、中断的 stale 任务。 */
export function runStartupMaintenance() {
  const cfg = getConfig();
  if (!cfg.startupMaintenanceEnabled) return;
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  // 重置 image_process_map 中 processing -> pending
  const rows = db
    .select({ id: schema.products.id, map: schema.products.imageProcessMapJson })
    .from(schema.products)
    .all();

  let touchedProducts = 0;
  for (const row of rows) {
    if (!row.map) continue;
    let map: ImageProcessMap;
    try {
      map = JSON.parse(row.map);
    } catch {
      continue;
    }
    if (!map || !Array.isArray(map.items)) continue;
    let changed = false;
    for (const item of map.items) {
      if (item.status === "processing") {
        item.status = "pending";
        item.error = "";
        changed = true;
      }
    }
    if (changed) {
      const processed = map.items.filter((i) => i.status === "approved" || i.status === "generated").length;
      const processing = map.items.filter((i) => i.status === "processing").length;
      db.update(schema.products)
        .set({
          imageProcessMapJson: JSON.stringify(map),
          processedImageCount: processed,
          processingImageCount: processing,
          updatedAt: now,
        })
        .where(eq(schema.products.id, row.id))
        .run();
      touchedProducts++;
    }
  }

  // 中断的 pending/running 任务 -> failed
  db.update(schema.jobs)
    .set({
      status: "failed",
      message: "服务重启，任务已中断",
      finishedAt: now,
      updatedAt: now,
    })
    .where(inArray(schema.jobs.status, ["pending", "running"]))
    .run();

  if (touchedProducts > 0) {
    console.log(`[启动维护] 已重置 ${touchedProducts} 个商品的处理中图片状态`);
  }
}

export interface ImageProcessItem {
  index: number;
  original_url: string;
  candidates: { path: string; created_at: string }[];
  selected_path: string;
  status: string;
  error: string;
  started_at?: string;
}

export interface ImageProcessMap {
  version: number;
  items: ImageProcessItem[];
}

export function getDb(): DB {
  if (!dbInstance) {
    throw new Error("Database not initialized. Call initDb() first.");
  }
  return dbInstance;
}

export function getRawSqlite(): Database.Database {
  if (!rawSqlite) {
    throw new Error("Database not initialized. Call initDb() first.");
  }
  return rawSqlite;
}

export function closeDb() {
  if (rawSqlite) {
    rawSqlite.close();
    rawSqlite = null;
    dbInstance = null;
  }
}

export { schema };
