import { loadGeneratedImage, GENERATED_IMAGE_MAX_BYTES } from "../../core/generated_image.js";
import { MediaGalleryBuilder, MessageFlags } from "discord.js";

import type {
  DiscordFileAttachment,
  DiscordMessage,
  SendableChannel,
} from "./stream_delivery.js";

export const DISCORD_GENERATED_IMAGE_MAX_BYTES = GENERATED_IMAGE_MAX_BYTES;

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

export async function loadGeneratedImageAttachment(imagePath: string, options: { maxBytes?: number } = {}): Promise<DiscordFileAttachment> {
  const { attachment, name } = await loadGeneratedImage(imagePath, options);
  return { attachment, name };
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
