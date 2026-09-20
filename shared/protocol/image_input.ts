export const WEB_IMAGE_MAX_COUNT = 4;
export const WEB_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const WEB_IMAGES_MAX_BYTES = 10 * 1024 * 1024;
export const WEB_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
/** Strict inline raster envelope; never accepts remote URLs or filesystem paths. */
export function imageDataParts(value: unknown): { mimeType: string; base64: string; bytes: number } | null {
  if (typeof value !== "string" || value.length > Math.ceil(WEB_IMAGE_MAX_BYTES / 3) * 4 + 64) return null;
  const comma = value.indexOf(",");
  const header = value.slice(0, comma);
  const mimeType = header.slice(5, -7);
  if (!header.startsWith("data:") || !header.endsWith(";base64") || !(WEB_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType)) return null;
  const base64 = value.slice(comma + 1);
  if (!base64 || base64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) return null;
  const bytes = base64.length / 4 * 3 - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
  return bytes > 0 && bytes <= WEB_IMAGE_MAX_BYTES ? { mimeType, base64, bytes } : null;
}
