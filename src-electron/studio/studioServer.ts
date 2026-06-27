/**
 * Amazon Image Studio 本地服务 —— 对应原 Flask 的 /studio 与 /api-proxy。
 *
 * 提供静态文件服务 + 配置接口 + 反向代理（注入 API key，非图片路径强制 stream +
 * 重写 responses -> chat/completions）。在 Electron 主进程内起一个 http 服务，
 * Studio 在新窗口加载该服务。
 */

import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { URL } from "node:url";
import { app } from "electron";
import { getConfig } from "../config";
import { httpRequestStream } from "../lib/http";

let server: http.Server | null = null;
let serverPort = 0;

const STUDIO_ASSETS_DIR = app.isPackaged
  ? path.join(process.resourcesPath, "studio")
  : path.join(__dirname, "..", "assets", "studio");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function mimeFor(filePath: string): string {
  return MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/** 启动 Studio 本地服务。返回端口。 */
export async function startStudioServer(): Promise<number> {
  if (server) return serverPort;
  return new Promise((resolve, reject) => {
    server = http.createServer(async (req, res) => {
      try {
        await handleRequest(req, res);
      } catch (err) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, message: String(err) }));
      }
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server?.address();
      serverPort = addr && typeof addr === "object" ? addr.port : 0;
      resolve(serverPort);
    });
  });
}

export function getStudioUrl(): string {
  return `http://127.0.0.1:${serverPort}/`;
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const cfg = getConfig();
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${serverPort}`);
  const pathname = url.pathname;

  // 配置接口
  if (pathname === "/studio/api/config") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        imageModel: cfg.studioImageModel || "",
        chatModel: cfg.studioChatModel || "",
        chatApiKey: cfg.studioChatApiKey || "",
        chatBaseUrl: cfg.studioChatBaseUrl || "",
      }),
    );
    return;
  }

  // 反向代理
  if (pathname.startsWith("/api-proxy/")) {
    await handleApiProxy(req, res, url);
    return;
  }

  // 静态文件
  let filePath = pathname === "/" || pathname === "/studio" ? "/index.html" : pathname;
  if (filePath.startsWith("/studio/")) filePath = filePath.slice("/studio".length);
  const target = path.join(STUDIO_ASSETS_DIR, filePath);
  const safe = path.resolve(target);
  if (!safe.startsWith(path.resolve(STUDIO_ASSETS_DIR)) || !existsSync(safe)) {
    // SPA fallback
    const index = path.join(STUDIO_ASSETS_DIR, "index.html");
    if (existsSync(index)) {
      const data = await readFile(index);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(data);
      return;
    }
    res.writeHead(404);
    res.end("Not Found");
    return;
  }
  const data = await readFile(safe);
  res.writeHead(200, { "Content-Type": mimeFor(safe) });
  res.end(data);
}

async function handleApiProxy(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const cfg = getConfig();
  const apiPath = url.pathname.slice("/api-proxy/".length);
  const isImage = apiPath.toLowerCase().startsWith("images/");

  let baseUrl: string;
  let apiKey: string;
  if (isImage) {
    baseUrl = cfg.studioApiBaseUrl.trim();
    apiKey = cfg.studioApiKey.trim();
  } else {
    baseUrl = (cfg.studioChatBaseUrl || cfg.studioApiBaseUrl).trim();
    apiKey = (cfg.studioChatApiKey || cfg.studioApiKey).trim();
  }
  if (!baseUrl) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: false, message: "STUDIO_API_BASE_URL 未配置" }));
    return;
  }
  if (!apiKey) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: false, message: "STUDIO_API_KEY 未配置" }));
    return;
  }

  // 读取请求体
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  let body = Buffer.concat(chunks);

  let targetPath = apiPath;
  if (!isImage) {
    try {
      const json = JSON.parse(body.toString("utf8"));
      json.stream = true;
      const chatModel = cfg.studioChatModel.trim();
      if (chatModel) json.model = chatModel;
      if (apiPath === "responses") {
        targetPath = "chat/completions";
        const rewritten = responsesToChat(json);
        body = Buffer.from(JSON.stringify(rewritten), "utf8");
      } else {
        body = Buffer.from(JSON.stringify(json), "utf8");
      }
    } catch {
      /* 非 JSON，原样转发 */
    }
  }

  const targetUrl = `${baseUrl.replace(/\/+$/, "")}/${targetPath}${url.search}`;
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
  const ct = req.headers["content-type"];
  if (ct) headers["Content-Type"] = ct;

  try {
    const upstream = await httpRequestStream(targetUrl, {
      method: req.method ?? "POST",
      headers,
      body: body.length ? body : undefined,
      timeoutMs: 600000,
    });
    res.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") ?? "application/json",
    });
    if (upstream.body) {
      const reader = upstream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    }
    res.end();
  } catch (err) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: false, message: `Studio API 请求失败: ${err}` }));
  }
}

/** 把 OpenAI Responses API 请求转换为 Chat Completions 格式。 */
function responsesToChat(payload: Record<string, unknown>): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];
  const instructions = payload.instructions;
  if (instructions) {
    messages.push({ role: "system", content: instructions });
    delete payload.instructions;
  }
  const input = payload.input;
  delete payload.input;
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (item && typeof item === "object") {
        const it = item as Record<string, unknown>;
        const role = it.role ?? "user";
        let content = it.content ?? "";
        if (Array.isArray(content)) {
          const parts: Record<string, unknown>[] = [];
          for (const part of content) {
            if (typeof part === "string") {
              parts.push({ type: "text", text: part });
            } else if (part && typeof part === "object") {
              const p = part as Record<string, unknown>;
              const ptype = p.type ?? "";
              if (ptype === "input_text" || "text" in p) {
                if (p.text) parts.push({ type: "text", text: p.text });
              } else if (ptype === "input_image" || "image_url" in p) {
                const u = p.image_url;
                if (u) parts.push({ type: "image_url", image_url: { url: typeof u === "string" ? u : (u as Record<string, unknown>).url } });
              }
            }
          }
          content = parts.length ? parts : "";
        }
        messages.push({ role, content });
      } else if (typeof item === "string") {
        messages.push({ role: "user", content: item });
      }
    }
  }
  payload.messages = messages;
  // 清理 Responses 专有字段
  for (const key of ["previous_response_id", "reasoning", "max_output_tokens", "max_tool_calls", "text", "store", "background", "output"]) {
    delete payload[key];
  }
  return payload;
}

export function stopStudioServer(): void {
  if (server) {
    server.close();
    server = null;
  }
}
