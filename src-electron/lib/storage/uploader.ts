/**
 * 图床上传抽象与工厂 —— 移植自 `image_uploader.py`。
 * 优先 R2，其次 imgbb。
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { getConfig } from "../../config";
import { uploadToR2 } from "./r2";
import { uploadToImgbb } from "./imgbb";

export interface ImageUploader {
  upload(filePath: string, opts?: { key?: string; itemCode?: string }): Promise<string>;
}

class R2Uploader {
  constructor(
    private accountId: string,
    private accessKeyId: string,
    private secretAccessKey: string,
    private bucket: string,
    private publicUrl: string,
    private prefix: string,
  ) {}

  get endpoint(): string {
    return `https://${this.accountId}.r2.cloudflarestorage.com`;
  }

  async upload(filePath: string, opts: { key?: string; itemCode?: string } = {}): Promise<string> {
    let key = opts.key ?? "";
    if (!key) key = generateKey(filePath, this.prefix, opts.itemCode ?? "");
    return uploadToR2({
      filePath,
      key,
      endpoint: this.endpoint,
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      bucket: this.bucket,
      publicUrl: this.publicUrl,
    });
  }
}

class ImgbbUploader {
  constructor(private apiKey: string) {}
  async upload(filePath: string): Promise<string> {
    return uploadToImgbb({ filePath, apiKey: this.apiKey });
  }
}

export function createUploader(): ImageUploader {
  const cfg = getConfig();
  if (cfg.r2AccountId) {
    return new R2Uploader(
      cfg.r2AccountId,
      cfg.r2AccessKeyId,
      cfg.r2SecretAccessKey,
      cfg.r2BucketName,
      cfg.r2PublicUrl,
      cfg.r2KeyPrefix,
    );
  }
  if (cfg.imgbbUploadApiKey) {
    return new ImgbbUploader(cfg.imgbbUploadApiKey);
  }
  throw new Error(
    "图床未配置。请设置 R2 环境变量 (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_PUBLIC_URL) 或 IMGBB_UPLOAD_API_KEY",
  );
}

export function isUploaderConfigured(): boolean {
  const cfg = getConfig();
  return Boolean(cfg.r2AccountId || cfg.imgbbUploadApiKey);
}

/** 生成 R2 key：prefix/年月/itemCode/图片md5.ext */
export function generateKey(filePath: string, prefix: string, itemCode: string): string {
  const body = readFileSync(filePath);
  const contentHash = createHash("md5").update(body).digest("hex").slice(0, 16);
  const ext = path.extname(filePath) || ".png";
  const datePart = new Date().toISOString().slice(0, 7).replace("-", "");
  const parts = [prefix, datePart].filter(Boolean);
  if (itemCode) parts.push(itemCode);
  return `${parts.join("/")}/${contentHash}${ext}`;
}
