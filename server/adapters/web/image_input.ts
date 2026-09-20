import { Buffer } from "node:buffer";
import { imageDataParts, WEB_IMAGE_MAX_COUNT, WEB_IMAGES_MAX_BYTES } from "../../../shared/protocol/image_input.js";
import { detectImageMimeType } from "../../core/image_media.js";
import { WebRequestError } from "./errors.js";

export const WEB_MESSAGE_MAX_BODY_BYTES = Math.ceil(WEB_IMAGES_MAX_BYTES / 3) * 4 + 256 * 1024;
export function validImageData(value: unknown): value is string {
  const parts = imageDataParts(value);
  return Boolean(parts && detectImageMimeType(Buffer.from(parts.base64, "base64")) === parts.mimeType);
}
export function readImageInputs(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > WEB_IMAGE_MAX_COUNT) throw new WebRequestError(400, "invalid_images", "Attach up to four PNG, JPEG, GIF, or WebP images.");
  let total = 0;
  for (const image of value) {
    const parts = imageDataParts(image);
    if (!parts || !validImageData(image)) throw new WebRequestError(400, "invalid_images", "Each image must contain valid PNG, JPEG, GIF, or WebP data, up to 5 MiB.");
    total += parts.bytes;
    if (total > WEB_IMAGES_MAX_BYTES) throw new WebRequestError(413, "images_too_large", "Images must total no more than 10 MiB per message.");
  }
  return value as string[];
}
