/**
 * 应用配置：从 `.env` 加载，对应原 Python `gigab2b_web/config.py`。
 *
 * `.env` 查找顺序：
 *   1. `GIGA_ENV_FILE` 环境变量指向的绝对路径
 *   2. `app.getPath('userData')/.env`
 *   3. 项目根（开发期 cwd）下的 `.env`
 *
 * 与原项目一致：时间均为 UTC+8 的 naive 时间戳（epoch 秒）。
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { app } from "electron";

export const PRODUCTION_OPENAPI_BASE_URL = "https://openapi.gigab2b.com";
export const SANDBOX_OPENAPI_BASE_URL = "https://openapi-sandbox.gigab2b.com";
export const GIGAB2B_WEB_BASE_URL = "https://www.gigab2b.com";

export interface AppConfig {
  // 通用
  environmentLabel: string;
  isDevelopment: boolean;

  // GIGA OpenAPI
  gigab2bClientId: string;
  gigab2bClientSecret: string;
  gigab2bOpenapiBaseUrl: string;
  gigab2bWebBaseUrl: string;

  // AI 图片生成（OpenAI 兼容）
  imgApiBaseUrl: string;
  imgApiModel: string;
  imgApiWireApi: string;
  imgApiKey: string;
  imgApiKeys: string[];
  imgApiGroup: string;
  imgApiStream: boolean;
  imgApiTimeout: number;
  imgApiPollInterval: number;

  // 图片分析 / vision
  imageAnalysisEnabled: boolean;
  imageAnalysisBaseUrl: string;
  imageAnalysisModel: string;
  imageAnalysisApiKey: string;
  imageAnalysisTimeout: number;
  imageAnalysisConcurrency: number;

  // 图片输出
  imageOutputSize: string;
  imageGenerationConcurrency: number;

  // 图片托管
  imgbbUploadApiKey: string;
  r2AccountId: string;
  r2AccessKeyId: string;
  r2SecretAccessKey: string;
  r2BucketName: string;
  r2PublicUrl: string;
  r2KeyPrefix: string;

  // WPS
  wpsWebhookUrl: string;
  wpsAirscriptToken: string;

  // 匿名商品解析
  anonymousProductSkuSyncEnabled: boolean;
  anonymousProductResolver: "local" | "worker";
  anonymousProductWorkerUrl: string;
  anonymousProductWorkerToken: string;
  anonymousProductWorkerTimeout: number;
  anonymousProductWorkerBatchSize: number;
  anonymousProductWorkerConcurrency: number;
  anonymousProductWorkerRequestConcurrency: number;
  anonymousProductVariantItemCodeEnabled: boolean;
  anonymousProductSkuConcurrency: number;

  // 本地目录
  modifyImagesRoot: string;
  localImagesRoot: string;

  // Studio
  studioStaticRoot: string;
  studioApiKey: string;
  studioApiBaseUrl: string;
  studioImageModel: string;
  studioChatModel: string;
  studioChatApiKey: string;
  studioChatBaseUrl: string;

  // 定时任务 / 维护
  priceInventorySyncEnabled: boolean;
  priceInventorySyncIntervalMinutes: number;
  startupMaintenanceEnabled: boolean;
}

let cachedConfig: AppConfig | null = null;

function boolEnv(env: Record<string, string>, name: string, def: boolean): boolean {
  const value = (env[name] ?? "").trim().toLowerCase();
  if (!value) return def;
  return ["1", "true", "yes", "y", "on"].includes(value);
}

function intEnv(env: Record<string, string>, name: string, def: number): number {
  const raw = (env[name] ?? "").trim();
  if (!raw) return def;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) return def;
  return Math.max(1, n);
}

function floatEnv(env: Record<string, string>, name: string, def: number): number {
  const raw = (env[name] ?? "").trim();
  if (!raw) return def;
  const n = Number.parseFloat(raw);
  if (Number.isNaN(n)) return def;
  return Math.max(0, n);
}

function strEnv(env: Record<string, string>, name: string, def: string): string {
  const value = (env[name] ?? "").trim();
  return value === "" ? def : value;
}

/**
 * 解析 `.env` 文件为 key/value 字典（不写入 process.env，避免污染）。
 * 与 Python `load_env_file` 行为一致：忽略空行/注释，去首尾引号。
 */
export function parseEnvFile(filePath: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (!existsSync(filePath)) return env;
  const text = readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const eq = line.indexOf("=");
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    value = value.replace(/^["'](.*)["']$/, "$1");
    if (key) env[key] = value;
  }
  return env;
}

/** 返回 `.env` 候选路径列表（按优先级）。 */
function envCandidates(): string[] {
  const list: string[] = [];
  const explicit = (process.env.GIGA_ENV_FILE ?? "").trim();
  if (explicit) list.push(explicit);
  try {
    list.push(path.join(app.getPath("userData"), ".env"));
  } catch {
    /* app 未就绪时忽略 */
  }
  list.push(path.resolve(process.cwd(), ".env"));
  return list;
}

/**
 * 加载并合并配置：`process.env` 优先于 `.env` 文件（与原项目 override=False 行为接近，
 * 但运行期显式设置的环境变量优先）。返回合并后的字典。
 */
function loadMergedEnv(): Record<string, string> {
  const fileEnv: Record<string, string> = {};
  for (const candidate of envCandidates()) {
    Object.assign(fileEnv, parseEnvFile(candidate));
  }
  const merged: Record<string, string> = { ...fileEnv };
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") merged[k] = v;
  }
  return merged;
}

/** 加载并缓存应用配置。 */
export function getConfig(): AppConfig {
  if (cachedConfig) return cachedConfig;

  const env = loadMergedEnv();
  const isDevelopment = !app.isPackaged;

  const gigab2bEnv = (env.GIGAB2B_ENV ?? "sandbox").trim().toLowerCase();
  const gigab2bOpenapiBaseUrl =
    strEnv(env, "GIGAB2B_BASE_URL", "") ||
    (gigab2bEnv === "production" ? PRODUCTION_OPENAPI_BASE_URL : SANDBOX_OPENAPI_BASE_URL);

  const imgApiBaseUrl = strEnv(env, "IMG_API_BASE_URL", "https://img-api.zxcode.vip");
  const imgApiKey = strEnv(env, "IMG_API_KEY", "");
  const imgApiKeys = imgApiKey
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);

  const modifyImagesRoot = strEnv(env, "MODIFY_IMAGES_ROOT", "modify-images");
  const localImagesRoot = strEnv(env, "LOCAL_IMAGES_ROOT", "local-images");

  const userDataPath = app.getPath("userData");

  cachedConfig = {
    environmentLabel: isDevelopment ? "开发环境 (development)" : "打包环境 (packaged)",
    isDevelopment,

    gigab2bClientId: strEnv(env, "GIGAB2B_CLIENT_ID", ""),
    gigab2bClientSecret: strEnv(env, "GIGAB2B_CLIENT_SECRET", ""),
    gigab2bOpenapiBaseUrl,
    gigab2bWebBaseUrl: strEnv(env, "GIGAB2B_WEB_BASE_URL", GIGAB2B_WEB_BASE_URL),

    imgApiBaseUrl,
    imgApiModel: strEnv(env, "IMG_API_MODEL", "gpt-image-2"),
    imgApiWireApi: strEnv(env, "IMG_API_WIRE_API", "chat_completions"),
    imgApiKey,
    imgApiKeys,
    imgApiGroup: strEnv(env, "IMG_API_GROUP", ""),
    imgApiStream: boolEnv(env, "IMG_API_STREAM", false),
    imgApiTimeout: floatEnv(env, "IMG_API_TIMEOUT", 300),
    imgApiPollInterval: floatEnv(env, "IMG_API_POLL_INTERVAL", 2),

    imageAnalysisEnabled: boolEnv(env, "IMAGE_ANALYSIS_ENABLED", false),
    imageAnalysisBaseUrl: strEnv(env, "IMAGE_ANALYSIS_BASE_URL", "") || imgApiBaseUrl,
    imageAnalysisModel: strEnv(env, "IMAGE_ANALYSIS_MODEL", "agnes-2.0-flash"),
    imageAnalysisApiKey: strEnv(env, "IMAGE_ANALYSIS_API_KEY", "") || imgApiKey,
    imageAnalysisTimeout: floatEnv(env, "IMAGE_ANALYSIS_TIMEOUT", 45),
    imageAnalysisConcurrency: intEnv(env, "IMAGE_ANALYSIS_CONCURRENCY", 3),

    imageOutputSize: strEnv(env, "IMAGE_OUTPUT_SIZE", "900x900"),
    imageGenerationConcurrency: intEnv(env, "IMAGE_GENERATION_CONCURRENCY", 5),

    imgbbUploadApiKey: strEnv(env, "IMGBB_UPLOAD_API_KEY", ""),
    r2AccountId: strEnv(env, "R2_ACCOUNT_ID", ""),
    r2AccessKeyId: strEnv(env, "R2_ACCESS_KEY_ID", ""),
    r2SecretAccessKey: strEnv(env, "R2_SECRET_ACCESS_KEY", ""),
    r2BucketName: strEnv(env, "R2_BUCKET_NAME", ""),
    r2PublicUrl: strEnv(env, "R2_PUBLIC_URL", ""),
    r2KeyPrefix: strEnv(env, "R2_KEY_PREFIX", "images") || "images",

    wpsWebhookUrl: strEnv(env, "WPS_WEBHOOK_URL", ""),
    wpsAirscriptToken: strEnv(env, "WPS_AIRSCRIPT_TOKEN", ""),

    anonymousProductSkuSyncEnabled: boolEnv(env, "ANONYMOUS_PRODUCT_SKU_SYNC_ENABLED", true),
    anonymousProductResolver: (strEnv(env, "ANONYMOUS_PRODUCT_RESOLVER", "local") as "local" | "worker") || "local",
    anonymousProductWorkerUrl: strEnv(env, "ANONYMOUS_PRODUCT_WORKER_URL", ""),
    anonymousProductWorkerToken: strEnv(env, "ANONYMOUS_PRODUCT_WORKER_TOKEN", ""),
    anonymousProductWorkerTimeout: floatEnv(env, "ANONYMOUS_PRODUCT_WORKER_TIMEOUT", 30),
    anonymousProductWorkerBatchSize: intEnv(env, "ANONYMOUS_PRODUCT_WORKER_BATCH_SIZE", 6),
    anonymousProductWorkerConcurrency: intEnv(env, "ANONYMOUS_PRODUCT_WORKER_CONCURRENCY", 3),
    anonymousProductWorkerRequestConcurrency: intEnv(env, "ANONYMOUS_PRODUCT_WORKER_REQUEST_CONCURRENCY", 10),
    anonymousProductVariantItemCodeEnabled: boolEnv(env, "ANONYMOUS_PRODUCT_VARIANT_ITEM_CODE_ENABLED", true),
    anonymousProductSkuConcurrency: intEnv(env, "ANONYMOUS_PRODUCT_SKU_CONCURRENCY", 10),

    modifyImagesRoot: path.isAbsolute(modifyImagesRoot)
      ? modifyImagesRoot
      : path.resolve(userDataPath, modifyImagesRoot),
    localImagesRoot: path.isAbsolute(localImagesRoot)
      ? localImagesRoot
      : path.resolve(userDataPath, localImagesRoot),

    studioStaticRoot: strEnv(env, "STUDIO_STATIC_ROOT", ""),
    studioApiKey: strEnv(env, "STUDIO_API_KEY", ""),
    studioApiBaseUrl: strEnv(env, "STUDIO_API_BASE_URL", ""),
    studioImageModel: strEnv(env, "STUDIO_IMAGE_MODEL", ""),
    studioChatModel: strEnv(env, "STUDIO_CHAT_MODEL", ""),
    studioChatApiKey: strEnv(env, "STUDIO_CHAT_API_KEY", ""),
    studioChatBaseUrl: strEnv(env, "STUDIO_CHAT_BASE_URL", ""),

    priceInventorySyncEnabled: boolEnv(env, "PRICE_INVENTORY_SYNC_ENABLED", true),
    priceInventorySyncIntervalMinutes: intEnv(env, "PRICE_INVENTORY_SYNC_INTERVAL_MINUTES", 60),
    startupMaintenanceEnabled: boolEnv(env, "STARTUP_MAINTENANCE_ENABLED", true),
  };

  return cachedConfig;
}
