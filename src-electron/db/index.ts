import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { app } from "electron";
import { mkdirSync } from "node:fs";
import * as schema from "./schema";

let dbInstance: ReturnType<typeof drizzle> | null = null;

/**
 * 是否打印 SQL 日志。
 * - 默认开启
 * - 设环境变量 DRIZZLE_LOG=false 可关闭
 */
function shouldLogSql(): boolean {
  const flag = process.env.DRIZZLE_LOG?.toLowerCase();
  if (flag === "false" || flag === "0") return false;
  return true;
}

/**
 * 初始化数据库。
 *
 * 数据库文件存放于 `app.getPath('userData')/app.db`，首次运行时创建。
 * 表结构通过内联 SQL 建表语句创建（与 db/schema.ts 保持一致），
 * 开发期可用 `pnpm drizzle-kit push` 在 ./app.db 上同步结构。
 */
export function initDb() {
  if (dbInstance) return dbInstance;

  const userDataPath = app.getPath("userData");
  mkdirSync(userDataPath, { recursive: true });
  const dbPath = path.join(userDataPath, "app.db");

  const sqlite = new Database(dbPath);
  // WAL 模式提升并发读写性能
  sqlite.pragma("journal_mode = WAL");

  // 建表（若不存在）
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS students (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      student_no  TEXT    NOT NULL UNIQUE,
      name        TEXT    NOT NULL,
      gender      TEXT    NOT NULL,
      age         INTEGER,
      major       TEXT,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);

  dbInstance = drizzle(sqlite, { schema, logger: shouldLogSql() });
  return dbInstance;
}

export function getDb() {
  if (!dbInstance) {
    throw new Error("Database not initialized. Call initDb() first.");
  }
  return dbInstance;
}

export { schema };
