/**
 * 图片分析 / vision 分类与场景描述 —— 移植自 `services.py` 的相关函数。
 */

import { httpRequestJson } from "../http";
import { IMAGE_CLASSIFICATION_PROMPT, SCENE_DESCRIPTION_PROMPT_TEMPLATE, SCENE_CONSTRAINTS, sceneStyleHint } from "./prompts";

export function imageAnalysisChatCompletionsUrl(baseUrl: string): string {
  const clean = baseUrl.trim().replace(/\/+$/, "");
  if (clean.endsWith("/v1/images/generations")) {
    return clean.slice(0, -"/images/generations".length) + "/chat/completions";
  }
  if (clean.endsWith("/images/generations")) {
    return clean.slice(0, -"/images/generations".length) + "/chat/completions";
  }
  if (clean.endsWith("/v1/chat/completions") || clean.endsWith("/chat/completions")) return clean;
  if (clean.endsWith("/v1")) return clean + "/chat/completions";
  return clean + "/v1/chat/completions";
}

function chatCompletionContent(response: Record<string, unknown>): string {
  const choices = response.choices as unknown[];
  if (!Array.isArray(choices) || !choices.length) return "";
  const msg = (choices[0] as Record<string, unknown>)?.message as Record<string, unknown> | undefined;
  const content = msg?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item === "string") parts.push(item);
      else if (item && typeof item === "object") {
        const it = item as Record<string, unknown>;
        const t = it.text ?? it.content;
        if (typeof t === "string" && t.trim()) parts.push(t.trim());
      }
    }
    return parts.join("\n");
  }
  return "";
}

function firstString(obj: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && String(v).trim()) return String(v);
  }
  return "";
}

export function normalizeImageClassificationMode(value: unknown): string {
  if (typeof value !== "string") return "";
  const v = value.toLowerCase().replace(/[-\s]/g, "_");
  if (!v) return "";
  if (["information", "infographic", "measurement", "dimension", "callout", "detail", "text_heavy"].some((t) => v.includes(t))) {
    return "information";
  }
  if (["plain", "lifestyle", "product_photo", "photo", "render"].some((t) => v.includes(t))) {
    return "plain";
  }
  return "";
}

export function textMentionsInformationImage(text: string): boolean {
  const t = text.toLowerCase();
  return ["information", "infographic", "measurement", "dimension", "callout", "label", "arrow", "text"].some((s) => t.includes(s));
}

export function classificationConfidence(value: unknown, def: number): number {
  let n = def;
  if (typeof value === "number") n = value;
  else if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (!Number.isNaN(parsed)) n = parsed;
  }
  if (n > 1) n = n / 100;
  return Math.max(0, Math.min(1, n));
}

export function parseImageClassificationContent(content: string): Record<string, unknown> | null {
  const text = content.trim();
  if (!text) return null;
  // 去除 ``` 围栏
  let cleaned = text;
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  }
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end < 0) {
    // 回退：根据文本判断
    const mode = textMentionsInformationImage(text) ? "information" : "plain";
    return { mode, confidence: 0, reason: "" };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    const mode = textMentionsInformationImage(text) ? "information" : "plain";
    return { mode, confidence: 0, reason: "" };
  }
  const mode = normalizeImageClassificationMode(
    parsed.mode ?? parsed.type ?? parsed.category ?? parsed.image_type ?? parsed.classification ?? text,
  );
  const finalMode = mode || (textMentionsInformationImage(text) ? "information" : "plain");
  const confidence = classificationConfidence(parsed.confidence, finalMode ? 0.75 : 0);
  const reason = firstString(parsed, "reason", "rationale", "summary");
  return {
    mode: finalMode,
    confidence,
    reason: (reason as string).slice(0, 240),
    has_text: Boolean(parsed.has_text),
    has_dimensions: Boolean(parsed.has_dimensions),
    has_callouts: Boolean(parsed.has_callouts),
  };
}

const SCENE_TRIGGER_REPLACEMENTS: [RegExp, string][] = [
  [/\bbedrooms?\b/gi, "room"],
  [/\b(?<!flower )beds?\b/gi, "frame"],
  [/\bbunks?\b/gi, "loft"],
  [/\bsleeping\b/gi, "resting"],
  [/\bsleep\b/gi, "rest"],
  [/\bdrapes\b/gi, "curtains"],
  [/\bnude\b/gi, "neutral"],
  [/\bnaked\b/gi, "bare"],
  [/\bguns?\b/gi, "tool"],
  [/\bweapons?\b/gi, "gear"],
];

export function sanitizeSceneText(text: string): string {
  let out = text;
  for (const [re, rep] of SCENE_TRIGGER_REPLACEMENTS) {
    out = out.replace(re, rep);
  }
  return out;
}

export function parseSceneDescriptionContent(content: string): { scene: string; product: string } {
  const text = content.trim();
  if (!text) return { scene: "", product: "" };
  let cleaned = text;
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  }
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end < 0) return { scene: "", product: "" };
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return { scene: "", product: "" };
  }
  const scene = firstString(parsed, "scene", "background", "setting");
  const product = firstString(parsed, "product", "product_subject", "subject");
  if (!scene) return { scene: "", product: "" };
  return { scene: sanitizeSceneText(scene).slice(0, 300), product: product.slice(0, 120) };
}

/** vision 分类源图。失败返回 null（不阻断生成）。 */
export async function classifySourceImageWithVision(
  sourceUrl: string,
  opts: { apiKey: string; baseUrl: string; model: string; timeout: number },
): Promise<Record<string, unknown> | null> {
  if (!/^https?:\/\//.test(sourceUrl)) return null;
  if (!opts.apiKey || !opts.baseUrl || !opts.model) return null;
  const url = imageAnalysisChatCompletionsUrl(opts.baseUrl);
  const payload = {
    model: opts.model.trim(),
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: IMAGE_CLASSIFICATION_PROMPT },
          { type: "image_url", image_url: { url: sourceUrl } },
        ],
      },
    ],
    temperature: 0,
    max_tokens: 240,
  };
  try {
    const resp = await httpRequestJson<Record<string, unknown>>(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      timeoutMs: Math.max(1000, opts.timeout * 1000),
    });
    const content = chatCompletionContent(resp);
    return parseImageClassificationContent(content);
  } catch {
    return null;
  }
}

/** vision 描述场景。失败返回 {}。 */
export async function describeSceneWithVision(
  sourceUrl: string,
  opts: { imageIndex: number; apiKey: string; baseUrl: string; model: string; timeout: number },
): Promise<{ scene: string; product: string }> {
  if (!/^https?:\/\//.test(sourceUrl)) return { scene: "", product: "" };
  if (!opts.apiKey || !opts.baseUrl || !opts.model) return { scene: "", product: "" };
  const url = imageAnalysisChatCompletionsUrl(opts.baseUrl);
  const promptText = SCENE_DESCRIPTION_PROMPT_TEMPLATE.replace("{image_index}", String(opts.imageIndex))
    .replace("{constraints}", SCENE_CONSTRAINTS)
    .replace("{style_hint}", sceneStyleHint(opts.imageIndex));
  const payload = {
    model: opts.model.trim(),
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: promptText },
          { type: "image_url", image_url: { url: sourceUrl } },
        ],
      },
    ],
    temperature: 0.7,
    max_tokens: 220,
  };
  try {
    const resp = await httpRequestJson<Record<string, unknown>>(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      timeoutMs: Math.max(1000, opts.timeout * 1000),
    });
    const content = chatCompletionContent(resp);
    return parseSceneDescriptionContent(content);
  } catch {
    return { scene: "", product: "" };
  }
}
