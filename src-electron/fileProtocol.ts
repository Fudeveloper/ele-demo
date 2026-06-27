/**
 * 文件协议：把 /api/files/<path> 形式的本地图片 URL 通过 app://giga-files/ 协议暴露给渲染进程。
 * 同时注册 CSP 放宽，允许加载 app:// 协议图片。
 */

import { protocol, session } from "electron";
import path from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { getConfig } from "./config";
import { lookup } from "mime-types";

const SCHEME = "giga-files";

/** 把存储路径（modify-images/... 或 local-images/...）解析为绝对路径。 */
export function resolveStoredPath(storedPath: string): string | null {
  const cfg = getConfig();
  const normalized = storedPath.replace(/\\/g, "/").replace(/^\//, "");
  if (normalized.startsWith("modify-images/")) {
    const rel = normalized.slice("modify-images/".length);
    const root = path.resolve(cfg.modifyImagesRoot);
    const target = path.resolve(root, rel);
    return target.startsWith(root) ? target : null;
  }
  if (normalized.startsWith("local-images/")) {
    const rel = normalized.slice("local-images/".length);
    const root = path.resolve(cfg.localImagesRoot);
    const target = path.resolve(root, rel);
    return target.startsWith(root) ? target : null;
  }
  return null;
}

/**
 * 必须在 app.whenReady() 之前调用，注册自定义协议方案。
 */
export function registerFileProtocolSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: true,
      },
    },
  ]);
}

/**
 * 必须在 app.whenReady() 之后调用，注册协议处理器与 CSP。
 */
export function registerFileProtocol(): void {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    // host 部分作为 path（app://giga-files/modify-images/...）
    let stored = url.pathname;
    if (stored.startsWith("/")) stored = stored.slice(1);
    // 拼回完整存储路径（host + pathname）
    const full = `${url.hostname}${url.pathname}`;
    const target = resolveStoredPath(full) ?? resolveStoredPath(stored);
    if (!target || !existsSync(target)) {
      return new Response("Not Found", { status: 404 });
    }
    const data = await readFile(target);
    const mime = lookup(target) || "application/octet-stream";
    return new Response(data as unknown as BodyInit, {
      status: 200,
      headers: { "Content-Type": mime as string, "Cache-Control": "public, max-age=3600" },
    });
  });

  // 放宽 CSP 允许加载 app:// 图片与外部图片
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: app: app://* http: https:",
        ],
      },
    });
  });
}
