/**
 * GIGA OpenAPI 签名 —— 精确移植自 `gigab2b_openapi/auth.py`。
 *
 * 签名 = base64( hex( hmac_sha256(key, message) ) )
 *   key     = `${client_id}&${client_secret}&${nonce}`
 *   message = `${client_id}&${api_path}&${timestamp}&${nonce}`
 */

import { createHmac, randomInt } from "node:crypto";
import { currentMillis } from "../util";

export const NONCE_LENGTH = 10;

/** 生成 10 位数字 nonce。 */
export function generateNonce(length: number = NONCE_LENGTH): string {
  if (length <= 0) throw new Error("nonce length must be greater than 0");
  let s = "";
  for (let i = 0; i < length; i++) {
    s += String(randomInt(0, 10));
  }
  return s;
}

export { currentMillis };

/** 生成 GIGA OpenAPI 2.0 请求签名。 */
export function generateSignature(opts: {
  clientId: string;
  clientSecret: string;
  apiPath: string;
  timestamp: string | number;
  nonce: string;
}): string {
  const { clientId, clientSecret, apiPath, timestamp, nonce } = opts;
  if (!clientId) throw new Error("client_id is required");
  if (!clientSecret) throw new Error("client_secret is required");
  if (!apiPath || !apiPath.startsWith("/")) throw new Error("api_path must start with '/'");
  if (nonce.length !== NONCE_LENGTH) throw new Error(`nonce must be ${NONCE_LENGTH} characters`);

  const timestampValue = String(timestamp);
  const message = `${clientId}&${apiPath}&${timestampValue}&${nonce}`;
  const secretKey = `${clientId}&${clientSecret}&${nonce}`;
  const hexDigest = createHmac("sha256", Buffer.from(secretKey, "utf8"))
    .update(Buffer.from(message, "utf8"))
    .digest("hex");
  return Buffer.from(hexDigest, "utf8").toString("base64");
}
