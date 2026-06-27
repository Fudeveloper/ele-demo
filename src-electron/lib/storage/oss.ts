/**
 * 阿里云 OSS 图片 URL 尺寸归一化 —— 移植自 `image_exporter.with_giga_ss_size`。
 *
 * 仅处理 gigab2b.cn / gigab2b.com 的 OSS 图片：
 *   - 已含 x-oss-process 的 resize：替换为 size x size
 *   - 未含：追加 image/resize,w_size,h_size,m_pad
 *   - 其它域名原样返回
 */

export const GIGA_OSS_HOSTS = [".gigab2b.cn", ".gigab2b.com"];
export const GIGA_OSS_PROCESS_KEY = "x-oss-process";
export const GIGA_OSS_TARGET_SIZE = 900;

const GIGA_OSS_RESIZE_RE = /(resize[,/])w_\d+([,/])h_\d+/;

export function withGigaOssSize(url: string, size: number = GIGA_OSS_TARGET_SIZE): string {
  if (typeof url !== "string") return url;
  const clean = url.trim();
  if (!clean) return clean;
  let host = "";
  try {
    host = new URL(clean).hostname;
  } catch {
    return clean;
  }
  if (!host || !GIGA_OSS_HOSTS.some((h) => host.endsWith(h))) return clean;

  const u = new URL(clean);
  const params = u.searchParams;
  const targetFragment = `resize,w_${size},h_${size},m_pad`;

  // 查找 x-oss-process（大小写不敏感）
  let foundKey: string | null = null;
  for (const key of params.keys()) {
    if (key.toLowerCase() === GIGA_OSS_PROCESS_KEY) {
      foundKey = key;
      break;
    }
  }

  if (foundKey) {
    let value = params.get(foundKey) ?? "";
    const replaced = value.replace(GIGA_OSS_RESIZE_RE, `$1w_${size}$2h_${size}`);
    if (replaced !== value) {
      params.set(foundKey, replaced);
    } else if (!value.includes("resize")) {
      params.set(foundKey, value ? `${value},${targetFragment}` : `image/${targetFragment}`);
    }
    // 已存在则不重复追加
  } else {
    params.set(GIGA_OSS_PROCESS_KEY, `image/${targetFragment}`);
  }

  return u.toString();
}
