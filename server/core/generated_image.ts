import { detectImageMimeType } from "./image_media.js";
import { Buffer } from "node:buffer";
import { open } from "node:fs/promises";
import path from "node:path";

export const GENERATED_IMAGE_MAX_BYTES = 10 * 1024 * 1024;


function extensionForMimeType(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    default:
      return ".png";
  }
}

function safeAttachmentName(imagePath: string, mimeType: string): string {
  const sourceName = path.basename(imagePath).replace(/[\u0000-\u001f\u007f]/g, "_");
  const sourceExtension = path.extname(sourceName).toLowerCase();
  const expectedExtension = extensionForMimeType(mimeType);
  const compatibleExtension =
    sourceExtension === expectedExtension ||
    (mimeType === "image/jpeg" && sourceExtension === ".jpeg");
  const baseName = (compatibleExtension
    ? sourceName.slice(0, -sourceExtension.length)
    : path.basename(sourceName, sourceExtension)
  ).trim();
  return `${(baseName || "generated-image").slice(0, 180)}${
    compatibleExtension ? sourceExtension : expectedExtension
  }`;
}

export async function loadGeneratedImage(
  imagePath: string,
  options: { maxBytes?: number } = {},
): Promise<{ attachment: Buffer; name: string; mimeType: string }> {
  const maxBytes = options.maxBytes ?? GENERATED_IMAGE_MAX_BYTES;
  if (!path.isAbsolute(imagePath)) {
    throw new Error("Generated image path must be absolute.");
  }

  const handle = await open(imagePath, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error("Generated image path is not a regular file.");
    }
    if (stat.size === 0) {
      throw new Error("Generated image file is empty.");
    }
    if (stat.size > maxBytes) {
      throw new Error(`Generated image exceeds the ${maxBytes} byte upload limit.`);
    }

    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const attachment = buffer.subarray(0, length);
    if (attachment.byteLength > maxBytes) {
      throw new Error(`Generated image exceeds the ${maxBytes} byte upload limit.`);
    }
    const mimeType = detectImageMimeType(attachment);
    if (!mimeType) {
      throw new Error("Generated image must be a PNG, JPEG, GIF, or WebP file.");
    }
    return {
      attachment,
      mimeType,
      name: safeAttachmentName(imagePath, mimeType),
    };
  } finally {
    await handle.close();
  }
}

