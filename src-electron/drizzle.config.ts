import { defineConfig } from "drizzle-kit";

/**
 * Drizzle Kit 配置。
 * 仅用于开发期同步 schema（`drizzle-kit push` / `generate`）。
 * 运行期数据库路径由主进程在 `app.getPath('userData')` 下动态创建，
 * 见 `src-electron/db/index.ts`。
 */
export default defineConfig({
  schema: "./db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: "./app.db"
  }
});
