/**
 * Cloudflare R2 S3 兼容上传（AWS Signature V4）—— 移植自 `r2_uploader.py`。
 * 无第三方依赖，用 node:crypto 签名。
 */

import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const SERVICE = "s3";
const REGION = "auto";

export interface UploadToR2Options {
  filePath: string;
  key: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicUrl: string;
  contentType?: string;
  timeout?: number;
}

export async function uploadToR2(opts: UploadToR2Options): Promise<string> {
  const { filePath, key, endpoint, accessKeyId, secretAccessKey, bucket, publicUrl } = opts;
  const contentType = opts.contentType || guessContentType(filePath);
  const timeout = opts.timeout ?? 120000;

  const body = readFileSync(filePath);
  const host = endpoint.replace(/^https?:\/\//, "");
  const objectPath = `/${bucket}/${key}`;
  const url = `https://${host}${objectPath}`;

  const now = new Date();
  const dateStamp = formatUtc(now, "YYYYMMDD");
  const amzDate = formatUtc(now, "YYYYMMDDTHHMMSSZ");

  const payloadHash = createHash("sha256").update(body).digest("hex");

  const headers: Record<string, string> = {
    "Content-Type": contentType,
    Host: host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };

  const canonicalHeaders =
    `content-type:${contentType}\n` +
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";

  const canonicalRequest = [
    "PUT",
    encodeObjectPath(objectPath),
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    createHash("sha256").update(Buffer.from(canonicalRequest, "utf8")).digest("hex"),
  ].join("\n");

  const signingKey = deriveSigningKey(secretAccessKey, dateStamp);
  const signature = createHmac("sha256", signingKey).update(Buffer.from(stringToSign, "utf8")).digest("hex");

  headers.Authorization =
    `AWS4-HMAC-SHA256 ` +
    `Credential=${accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, ` +
    `Signature=${signature}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "PUT",
      headers,
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`R2 上传失败 (HTTP ${resp.status}): ${detail.slice(0, 200)}`);
  }

  return `${publicUrl.replace(/\/+$/, "")}/${key}`;
}

function deriveSigningKey(secretKey: string, dateStamp: string): Buffer {
  const kDate = createHmac("sha256", Buffer.from(`AWS4${secretKey}`, "utf8"))
    .update(Buffer.from(dateStamp, "utf8"))
    .digest();
  const kRegion = createHmac("sha256", kDate).update(Buffer.from(REGION, "utf8")).digest();
  const kService = createHmac("sha256", kRegion).update(Buffer.from(SERVICE, "utf8")).digest();
  return createHmac("sha256", kService).update(Buffer.from("aws4_request", "utf8")).digest();
}

function encodeObjectPath(objectPath: string): string {
  return objectPath
    .split("/")
    .map((seg) => (seg === "" ? "" : encodeURIComponent(seg)))
    .join("/");
}

export function guessContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
  };
  return map[ext] ?? "application/octet-stream";
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** UTC 格式化为 YYYYMMDD 或 YYYYMMDDTHHMMSSZ。 */
function formatUtc(d: Date, fmt: "YYYYMMDD" | "YYYYMMDDTHHMMSSZ"): string {
  const y = d.getUTCFullYear();
  const mo = pad(d.getUTCMonth() + 1);
  const da = pad(d.getUTCDate());
  if (fmt === "YYYYMMDD") return `${y}${mo}${da}`;
  const h = pad(d.getUTCHours());
  const mi = pad(d.getUTCMinutes());
  const s = pad(d.getUTCSeconds());
  return `${y}${mo}${da}T${h}${mi}${s}Z`;
}
