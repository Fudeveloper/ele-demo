/**
 * 图像像素级处理 —— 移植自 `image_background_modifier.py` + `services.py` 中的
 * 信息区域保护、颜色提取、信息图分类启发式。
 *
 * 用 sharp 替代 PIL。sharp 提供 raw pixel buffer，连通域/掩码逻辑自行实现。
 */

import sharp, { type Channels } from "sharp";
import { httpRequest } from "../http";
import { ProductImageUrlExportError } from "../gigab2b/exceptions";

export interface RawImage {
  width: number;
  height: number;
  channels: Channels;
  data: Buffer; // RGBA
}

/** 下载并解码为 RGBA RawImage。 */
export async function loadImageRgba(source: string): Promise<RawImage> {
  let buffer: Buffer;
  if (/^https?:\/\//.test(source)) {
    const resp = await httpRequest(source, {
      headers: {
        "User-Agent": "Mozilla/5.0 GigaB2B image processing",
        Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      },
      timeoutMs: 30000,
    });
    if (!resp.ok) throw new ProductImageUrlExportError(`load image failed: HTTP ${resp.status}`);
    buffer = Buffer.from(resp.bytes);
  } else {
    const { readFileSync } = await import("node:fs");
    buffer = readFileSync(source);
  }
  const { data, info } = await sharp(buffer)
    .rotate() // EXIF 方向
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, channels: info.channels as Channels, data };
}

/** to RGB buffer（3 通道）。 */
export function toRgb(img: RawImage): { width: number; height: number; data: Uint8Array } {
  const out = new Uint8Array(img.width * img.height * 3);
  for (let i = 0, j = 0; i < img.data.length; i += img.channels) {
    out[j++] = img.data[i]!;
    out[j++] = img.data[i + 1]!;
    out[j++] = img.data[i + 2]!;
  }
  return { width: img.width, height: img.height, data: out };
}

function rgbAt(rgb: { data: Uint8Array; width: number }, x: number, y: number): [number, number, number] {
  const i = (y * rgb.width + x) * 3;
  return [rgb.data[i]!, rgb.data[i + 1]!, rgb.data[i + 2]!];
}

// ============ 信息图分类（像素启发式） ============

export interface ClassificationRatios {
  lightRatio: number;
  whiteRatio: number;
  darkInkRatio: number;
  topLightRatio: number;
  topOrangeRatio: number;
  topBlueRatio: number;
  topDarkInkRatio: number;
  hasTopSellingPointBand: boolean;
}

export function looksLikeWhiteMeasurementDiagram(r: ClassificationRatios): boolean {
  return (
    !r.hasTopSellingPointBand &&
    r.lightRatio >= 0.7 &&
    r.whiteRatio >= 0.45 &&
    r.darkInkRatio >= 0.012 &&
    r.topLightRatio >= 0.78 &&
    r.topDarkInkRatio >= 0.01
  );
}

export function looksLikePlainWhiteProductRender(r: ClassificationRatios): boolean {
  return (
    !r.hasTopSellingPointBand &&
    r.whiteRatio >= 0.55 &&
    r.lightRatio >= 0.6 &&
    r.topLightRatio >= 0.9 &&
    r.topOrangeRatio < 0.03 &&
    r.topBlueRatio < 0.008 &&
    r.topDarkInkRatio < 0.06
  );
}

export function hasColoredTopSellingPointBand(r: ClassificationRatios): boolean {
  return (
    r.topLightRatio >= 0.18 &&
    r.topOrangeRatio >= 0.08 &&
    (r.topBlueRatio >= 0.008 || r.topDarkInkRatio >= 0.02)
  );
}

function isOrange(r: number, g: number, b: number): boolean {
  return r >= 170 && g >= 80 && g <= 205 && b <= 120 && r - b >= 60;
}
function isBlue(r: number, g: number, b: number): boolean {
  return b >= 110 && r <= 110 && g <= 160 && b - r >= 45;
}
function isLight(r: number, g: number, b: number): boolean {
  return r >= 235 && g >= 235 && b >= 235;
}
function isWhite(r: number, g: number, b: number): boolean {
  return r >= 245 && g >= 245 && b >= 245;
}
function isDarkInk(r: number, g: number, b: number): boolean {
  return r <= 90 && g <= 90 && b <= 90;
}

export function computeClassificationRatios(rgb: {
  width: number;
  height: number;
  data: Uint8Array;
}): ClassificationRatios {
  const { width: W, height: H, data } = rgb;
  const total = W * H;
  const topLimit = Math.max(1, Math.floor(H / 3));
  let light = 0,
    white = 0,
    darkInk = 0;
  let topTotal = 0,
    topLight = 0,
    topOrange = 0,
    topBlue = 0,
    topDarkInk = 0;
  for (let y = 0; y < H; y++) {
    const inTop = y < topLimit;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      const r = data[i]!,
        g = data[i + 1]!,
        b = data[i + 2]!;
      if (isLight(r, g, b)) light++;
      if (isWhite(r, g, b)) white++;
      if (isDarkInk(r, g, b)) darkInk++;
      if (inTop) {
        topTotal++;
        if (isLight(r, g, b)) topLight++;
        if (isOrange(r, g, b)) topOrange++;
        if (isBlue(r, g, b)) topBlue++;
        if (isDarkInk(r, g, b)) topDarkInk++;
      }
    }
  }
  const ratios: ClassificationRatios = {
    lightRatio: light / total,
    whiteRatio: white / total,
    darkInkRatio: darkInk / total,
    topLightRatio: topTotal ? topLight / topTotal : 0,
    topOrangeRatio: topTotal ? topOrange / topTotal : 0,
    topBlueRatio: topTotal ? topBlue / topTotal : 0,
    topDarkInkRatio: topTotal ? topDarkInk / topTotal : 0,
    hasTopSellingPointBand: false,
  };
  ratios.hasTopSellingPointBand = hasColoredTopSellingPointBand(ratios);
  return ratios;
}

/** 判断 source_url 是否为信息图（本地像素启发式）。 */
export async function sourceLooksLikeInformationImage(sourceUrl: string): Promise<boolean> {
  let img: RawImage;
  try {
    img = await loadImageRgba(sourceUrl);
  } catch {
    return false;
  }
  // 缩小到 384x384
  const resized = await sharp(img.data, {
    raw: { width: img.width, height: img.height, channels: img.channels },
  })
    .resize(384, 384, { fit: "inside" })
    .toBuffer();
  const meta = await sharp(resized).metadata();
  const small: RawImage = {
    width: meta.width ?? 384,
    height: meta.height ?? 384,
    channels: meta.channels ?? 4,
    data: resized,
  };
  const rgb = toRgb(small);
  if (!rgb.data.length) return false;
  const r = computeClassificationRatios(rgb);
  const hasWhiteMeasurement = looksLikeWhiteMeasurementDiagram(r);
  const plain = looksLikePlainWhiteProductRender(r);
  return (
    hasWhiteMeasurement ||
    (!plain &&
      ((r.lightRatio >= 0.28 && r.darkInkRatio >= 0.012) ||
        r.whiteRatio >= 0.4 ||
        r.hasTopSellingPointBand))
  );
}

// ============ 颜色提取 ============

export function rgbToColorName(r: number, g: number, b: number): string {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  if (mx >= 210 && mx - mn <= 30) return "white";
  if (mn <= 45 && mx - mn <= 30) return "black";
  if (mx - mn <= 30) {
    const mid = (mx + mn) / 2;
    if (mid < 95) return "charcoal";
    if (mid < 160) return "grey";
    return "light grey";
  }
  // HSV hue
  const d = mx - mn;
  let h = 0;
  if (mx === r) h = ((g - b) / d) % 6;
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  if (h < 16 || h >= 345) return "red";
  if (h < 45) return "orange";
  if (h < 70) return "yellow";
  if (h < 165) return "green";
  if (h < 200) return "teal";
  if (h < 255) return "blue";
  if (h < 290) return "purple";
  return "pink";
}

export async function extractProductColors(sourceUrl: string, topN = 3): Promise<string> {
  if (!sourceUrl.trim()) return "";
  let img: RawImage;
  try {
    img = await loadImageRgba(sourceUrl);
  } catch {
    return "";
  }
  // 缩小到 100x100
  const small = await sharp(img.data, {
    raw: { width: img.width, height: img.height, channels: img.channels },
  })
    .resize(100, 100, { fit: "inside" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const full = toRgb({
    width: small.info.width,
    height: small.info.height,
    channels: small.info.channels as Channels,
    data: small.data,
  });
  const buckets = new Map<string, number>();
  for (let i = 0; i < full.data.length; i += 3) {
    const r = full.data[i]!,
      g = full.data[i + 1]!,
      b = full.data[i + 2]!;
    const key = `${Math.floor(r / 48)},${Math.floor(g / 48)},${Math.floor(b / 48)}`;
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  const total = full.data.length / 3;
  const sorted = [...buckets.entries()].sort((a, b) => b[1] - a[1]);
  const names: string[] = [];
  for (const [key, count] of sorted) {
    const [bkx, bky, bkz] = key.split(",").map(Number);
    const name = rgbToColorName((bkx ?? 0) * 48 + 24, (bky ?? 0) * 48 + 24, (bkz ?? 0) * 48 + 24);
    const pct = count / total;
    if (names.includes(name)) continue;
    if (pct < 0.06 && names.length) continue;
    names.push(name);
    if (names.length >= topN) break;
  }
  return names.join(", ");
}

// ============ normalize / mirror ============

/** 把生成图归一到 output_size 画布（contain + 白底）。 */
export async function normalizeGeneratedImage(outputPath: string, outputSize: [number, number]): Promise<void> {
  const [W, H] = outputSize;
  const buf = await sharp(outputPath).rotate().toBuffer();
  const meta = await sharp(buf).metadata();
  if (meta.width === W && meta.height === H && meta.channels === 3) {
    // 直接保持
    return;
  }
  await sharp(buf)
    .resize(W, H, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .toFile(outputPath + ".tmp");
  const { renameSync } = await import("node:fs");
  renameSync(outputPath + ".tmp", outputPath);
}

/** 水平镜像。 */
export async function mirrorOutput(outputPath: string): Promise<void> {
  const buf = await sharp(outputPath).flop().toBuffer();
  const { writeFileSync } = await import("node:fs");
  writeFileSync(outputPath, buf);
}

/** 把图像 contain 到 output 画布并返回 RGBA RawImage（用于信息区域保护）。 */
export async function fitImageToOutputCanvasRgba(
  source: RawImage,
  outputSize: [number, number],
): Promise<RawImage> {
  const [W, H] = outputSize;
  const resized = await sharp(source.data, {
    raw: { width: source.width, height: source.height, channels: source.channels },
  })
    .resize(W, H, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    width: resized.info.width,
    height: resized.info.height,
    channels: resized.info.channels,
    data: resized.data,
  };
}

// ============ 信息区域保护（连通域掩码） ============

interface ConnectedComponent {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  count: number;
  pixels: number[]; // 像素索引列表
}

function isInformationInk(r: number, g: number, b: number): boolean {
  return r < 235 || g < 235 || b < 235;
}

/** 4-连通域 flood fill。maskData: 0/255。返回组件列表。 */
function connectedMaskComponents(
  maskData: Uint8Array,
  W: number,
  H: number,
): ConnectedComponent[] {
  const visited = new Uint8Array(W * H);
  const components: ConnectedComponent[] = [];
  for (let start = 0; start < W * H; start++) {
    if (visited[start] || maskData[start] === 0) continue;
    const pixels: number[] = [];
    let minX = W,
      minY = H,
      maxX = 0,
      maxY = 0;
    const stack = [start];
    visited[start] = 1;
    while (stack.length) {
      const idx = stack.pop()!;
      const x = idx % W;
      const y = Math.floor(idx / W);
      pixels.push(idx);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      // 4 邻
      const neighbors = [
        x > 0 ? idx - 1 : -1,
        x < W - 1 ? idx + 1 : -1,
        y > 0 ? idx - W : -1,
        y < H - 1 ? idx + W : -1,
      ];
      for (const n of neighbors) {
        if (n < 0 || visited[n] || maskData[n] === 0) continue;
        visited[n] = 1;
        stack.push(n);
      }
    }
    components.push({ minX, minY, maxX, maxY, count: pixels.length, pixels });
  }
  return components;
}

function isInformationComponent(c: ConnectedComponent, W: number, H: number): boolean {
  if (c.count <= 1) return false;
  const boxW = c.maxX - c.minX + 1;
  const boxH = c.maxY - c.minY + 1;
  const area = boxW * boxH;
  const canvasArea = W * H;
  const lineLike = boxH <= Math.max(14, Math.floor(H * 0.02)) || boxW <= Math.max(14, Math.floor(W * 0.02));
  const textLike = area <= canvasArea * 0.035 && boxH <= Math.max(90, Math.floor(H * 0.14));
  const smallLabel = area <= canvasArea * 0.018;
  const mediumAnnotation = c.count <= canvasArea * 0.035 && (boxH <= H * 0.22 || boxW <= W * 0.22);
  const sourceContent = c.count <= canvasArea * 0.35 && area <= canvasArea * 0.6;
  return lineLike || textLike || smallLabel || mediumAnnotation || sourceContent;
}

function isLargeSourceContentComponent(c: ConnectedComponent, W: number, H: number): boolean {
  const boxW = c.maxX - c.minX + 1;
  const boxH = c.maxY - c.minY + 1;
  const area = boxW * boxH;
  const canvasArea = W * H;
  return area >= canvasArea * 0.1 && c.count >= canvasArea * 0.05;
}

function needsSourceContentBackdrop(c: ConnectedComponent, W: number, H: number): boolean {
  if (Math.min(W, H) < 300) return false;
  const boxW = c.maxX - c.minX + 1;
  const boxH = c.maxY - c.minY + 1;
  const area = boxW * boxH;
  const canvasArea = W * H;
  return canvasArea * 0.15 <= area && area <= canvasArea * 0.35 && c.count >= canvasArea * 0.05;
}

function isTopSellingPointComponent(c: ConnectedComponent, W: number, H: number): boolean {
  const boxW = c.maxX - c.minX + 1;
  const boxH = c.maxY - c.minY + 1;
  const canvasArea = W * H;
  const titlePill =
    c.minY <= H * 0.15 &&
    boxW >= W * 0.35 &&
    H * 0.03 <= boxH &&
    boxH <= H * 0.16 &&
    c.count >= canvasArea * 0.015;
  const calloutCard =
    c.minY <= H * 0.38 &&
    boxW * boxH >= canvasArea * 0.002 &&
    boxW <= W * 0.22 &&
    boxH <= H * 0.24 &&
    c.count >= 120;
  return titlePill || calloutCard;
}

/** 3x3 最大值膨胀。 */
function maxFilter3(mask: Uint8Array, W: number, H: number): Uint8Array {
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let m = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx,
            ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const mv = mask[ny * W + nx] ?? 0;
          if (mv > m) m = mv;
        }
      }
      out[y * W + x] = m;
    }
  }
  return out;
}

/** 9x9 最大值膨胀（简化为多次 3x3）。 */
function maxFilter9(mask: Uint8Array, W: number, H: number): Uint8Array {
  return maxFilter3(maxFilter3(maxFilter3(mask, W, H), W, H), W, H);
}

/** 构建信息区域掩码（255 = 保护区域）。 */
function informationRegionMask(sourceRgb: { width: number; height: number; data: Uint8Array }): Uint8Array {
  const { width: W, height: H, data } = sourceRgb;
  const candidates = new Uint8Array(W * H);
  for (let i = 0, p = 0; i < data.length; i += 3, p++) {
    if (isInformationInk(data[i]!, data[i + 1]!, data[i + 2]!)) candidates[p] = 255;
  }
  const largeContent = new Uint8Array(W * H);
  const detail = new Uint8Array(W * H);
  const backdrop = new Uint8Array(W * H);
  const components = connectedMaskComponents(candidates, W, H);
  for (const c of components) {
    if (!isInformationComponent(c, W, H)) continue;
    if (needsSourceContentBackdrop(c, W, H)) {
      const hPad = Math.max(24, Math.floor(Math.min(W, H) / 18));
      const boxH = c.maxY - c.minY + 1;
      const vPad = Math.max(24, boxH);
      const x0 = Math.max(0, c.minX - hPad);
      const y0 = Math.max(0, c.minY - vPad);
      const x1 = Math.min(W - 1, c.maxX + hPad);
      const y1 = Math.min(H - 1, c.maxY + vPad);
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) backdrop[y * W + x] = 255;
      }
    }
    const target = isLargeSourceContentComponent(c, W, H) ? largeContent : detail;
    for (const p of c.pixels) target[p] = 255;
  }
  const dilatedLarge = maxFilter3(largeContent, W, H);
  const dilatedDetail = maxFilter9(detail, W, H);
  const mask = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    if (dilatedLarge[i] || dilatedDetail[i] || backdrop[i]) mask[i] = 255;
  }
  addColoredTopSellingPointRegions(mask, sourceRgb);
  return mask;
}

function addColoredTopSellingPointRegions(
  mask: Uint8Array,
  rgb: { width: number; height: number; data: Uint8Array },
): void {
  const { width: W, height: H, data } = rgb;
  const topLimit = Math.max(1, Math.floor(H / 3));
  let topTotal = 0,
    topLight = 0,
    topOrange = 0,
    topBlue = 0,
    topDarkInk = 0;
  for (let y = 0; y < topLimit; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      const r = data[i]!,
        g = data[i + 1]!,
        b = data[i + 2]!;
      topTotal++;
      if (isLight(r, g, b)) topLight++;
      if (isOrange(r, g, b)) topOrange++;
      if (isBlue(r, g, b)) topBlue++;
      if (isDarkInk(r, g, b)) topDarkInk++;
    }
  }
  const ratios: ClassificationRatios = {
    lightRatio: 0,
    whiteRatio: 0,
    darkInkRatio: 0,
    topLightRatio: topTotal ? topLight / topTotal : 0,
    topOrangeRatio: topTotal ? topOrange / topTotal : 0,
    topBlueRatio: topTotal ? topBlue / topTotal : 0,
    topDarkInkRatio: topTotal ? topDarkInk / topTotal : 0,
    hasTopSellingPointBand: false,
  };
  if (!hasColoredTopSellingPointBand(ratios)) return;
  const bandLimit = Math.min(H - 1, Math.floor(H * 0.38));
  const uiMask = new Uint8Array(W * H);
  for (let y = 0; y <= bandLimit; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      const r = data[i]!,
        g = data[i + 1]!,
        b = data[i + 2]!;
      if (isWhite(r, g, b) || isOrange(r, g, b)) uiMask[y * W + x] = 255;
    }
  }
  const components = connectedMaskComponents(uiMask, W, H);
  for (const c of components) {
    if (!isTopSellingPointComponent(c, W, H)) continue;
    const x0 = Math.max(0, c.minX - 2);
    const y0 = Math.max(0, c.minY - 2);
    const x1 = Math.min(W - 1, c.maxX + 2);
    const y1 = Math.min(H - 1, c.maxY + 2);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) mask[y * W + x] = 255;
    }
  }
}

/** 在生成图上保留源图的信息区域。返回是否执行了保留。 */
export async function preserveInformationRegions(
  outputPath: string,
  sourceUrl: string,
  outputSize: [number, number],
): Promise<boolean> {
  let sourceRaw: RawImage;
  try {
    sourceRaw = await loadImageRgba(sourceUrl);
  } catch {
    return false;
  }
  const sourceCanvas = await fitImageToOutputCanvasRgba(sourceRaw, outputSize);
  const sourceRgb = toRgb(sourceCanvas);
  const mask = informationRegionMask(sourceRgb);
  // bbox 检查
  let hasAny = false;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) {
      hasAny = true;
      break;
    }
  }
  if (!hasAny) return false;

  const generatedBuf = await sharp(outputPath).rotate().toBuffer();
  const genMeta = await sharp(generatedBuf).metadata();
  let genCanvas: RawImage;
  if (genMeta.width === outputSize[0] && genMeta.height === outputSize[1]) {
    const { data, info } = await sharp(generatedBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    genCanvas = { width: info.width, height: info.height, channels: info.channels, data };
  } else {
    const { data, info } = await sharp(generatedBuf)
      .resize(outputSize[0], outputSize[1], { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 1 } })
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    genCanvas = { width: info.width, height: info.height, channels: info.channels, data };
  }

  // 把 source 的像素按 mask 拷到 genCanvas
  const W = outputSize[0];
  const H = outputSize[1];
  const genRgb = toRgb(genCanvas);
  for (let p = 0; p < W * H; p++) {
    if (mask[p]) {
      genRgb.data[p * 3] = sourceRgb.data[p * 3]!;
      genRgb.data[p * 3 + 1] = sourceRgb.data[p * 3 + 1]!;
      genRgb.data[p * 3 + 2] = sourceRgb.data[p * 3 + 2]!;
    }
  }
  // 写回
  const outBuf = await sharp(Buffer.from(genRgb.data), {
    raw: { width: W, height: H, channels: 3 },
  })
    .toBuffer();
  const { writeFileSync } = await import("node:fs");
  writeFileSync(outputPath, outBuf);
  return true;
}
