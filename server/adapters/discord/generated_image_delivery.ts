import { Buffer } from "node:buffer";
import { open } from "node:fs/promises";
import path from "node:path";
import { MediaGalleryBuilder, MessageFlags } from "discord.js";

import type {
  DiscordFileAttachment,
  DiscordMessage,
  SendableChannel,
} from "./stream_delivery.js";

export const DISCORD_GENERATED_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

export type GeneratedImageAttachmentLoader = (
  imagePath: string,
) => Promise<DiscordFileAttachment>;

export type DiscordGeneratedImageDeliveryResult = {
  success: boolean;
  messageId: string | null;
  error: string | null;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function detectImageMimeType(body: Buffer): string | null {
  if (
    body.length >= 8 &&
    body.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  ) {
    return "image/png";
  }
  if (body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) {
    return "image/jpeg";
  }
  const header = body.subarray(0, 12).toString("ascii");
  if (header.startsWith("GIF87a") || header.startsWith("GIF89a")) {
    return "image/gif";
  }
  if (header.startsWith("RIFF") && header.slice(8, 12) === "WEBP") {
    return "image/webp";
  }
  return null;
}

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

export async function loadGeneratedImageAttachment(
  imagePath: string,
  options: { maxBytes?: number } = {},
): Promise<DiscordFileAttachment> {
  const maxBytes = options.maxBytes ?? DISCORD_GENERATED_IMAGE_MAX_BYTES;
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

    const attachment = await handle.readFile();
    if (attachment.byteLength > maxBytes) {
      throw new Error(`Generated image exceeds the ${maxBytes} byte upload limit.`);
    }
    const mimeType = detectImageMimeType(attachment);
    if (!mimeType) {
      throw new Error("Generated image must be a PNG, JPEG, GIF, or WebP file.");
    }
    return {
      attachment,
      name: safeAttachmentName(imagePath, mimeType),
    };
  } finally {
    await handle.close();
  }
}

export async function sendDiscordGeneratedImage(
  channel: SendableChannel,
  imagePath: string,
  options: {
    description?: string | null;
    loadAttachment?: GeneratedImageAttachmentLoader;
  } = {},
): Promise<DiscordGeneratedImageDeliveryResult> {
  try {
    const loadAttachment = options.loadAttachment ?? loadGeneratedImageAttachment;
    const attachment = await loadAttachment(imagePath);
    const description = options.description?.trim().slice(0, 1_024);
    const file = {
      ...attachment,
      ...(description ? { description } : {}),
    };
    const gallery = new MediaGalleryBuilder().addItems((item) => {
      item.setURL(`attachment://${attachment.name}`);
      if (description) item.setDescription(description);
      return item;
    });
    const sent: DiscordMessage = await channel.send({
      flags: MessageFlags.IsComponentsV2,
      components: [gallery],
      files: [file],
    });
    return {
      success: true,
      messageId: sent.id,
      error: null,
    };
  } catch (error) {
    return {
      success: false,
      messageId: null,
      error: errorMessage(error),
    };
  }
}
