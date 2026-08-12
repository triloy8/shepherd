import type { APIEmbed, TextBasedChannel } from "discord.js";
import type { Buffer } from "node:buffer";

import {
  chunkForDiscord,
  DISCORD_CHUNK_TARGET,
  DISCORD_MESSAGE_LIMIT,
} from "./chunking.js";
import { isEmbedRejection } from "./embed_renderer.js";

export type DiscordMessage = {
  id: string;
  edit: (
    content:
      | string
      | { content?: string | null; embeds?: APIEmbed[]; components?: unknown[] },
  ) => Promise<unknown>;
};

export type DiscordFileAttachment = {
  attachment: Buffer;
  name: string;
  description?: string;
};

export type SendableChannel = TextBasedChannel & {
  send: (
    content:
      | string
      | {
          content?: string;
          components?: unknown[];
          embeds?: APIEmbed[];
          files?: DiscordFileAttachment[];
          reply?: { messageReference: string; failIfNotExists?: boolean };
          allowedMentions?: { repliedUser?: boolean; parse?: string[] };
        },
  ) => Promise<DiscordMessage>;
  sendTyping?: () => Promise<unknown>;
  messages: { fetch: (id: string) => Promise<DiscordMessage> };
};

export type DiscordDeliveryResult = {
  success: boolean;
  messageIds: string[];
  deliveredChunks: number;
  totalChunks: number;
  partial: boolean;
  error: string | null;
  usedFallback?: boolean;
};

export type DiscordPreviewState = {
  messageId: string | null;
  renderedText: string;
  saturatedText: string | null;
  continuationMessageIds: string[];
};

export type DiscordEditableChunksState = {
  messageIds: string[];
  renderedChunks: string[];
};

export type DiscordEditableEmbedsState = {
  messageIds: string[];
  renderedEmbeds: string[];
  fallbackIndexes: Set<number>;
};

export function createDiscordPreviewState(): DiscordPreviewState {
  return {
    messageId: null,
    renderedText: "",
    saturatedText: null,
    continuationMessageIds: [],
  };
}

export function createDiscordEditableChunksState(): DiscordEditableChunksState {
  return {
    messageIds: [],
    renderedChunks: [],
  };
}

export function createDiscordEditableEmbedsState(): DiscordEditableEmbedsState {
  return { messageIds: [], renderedEmbeds: [], fallbackIndexes: new Set<number>() };
}

export { chunkForDiscord, DISCORD_CHUNK_TARGET, DISCORD_MESSAGE_LIMIT } from "./chunking.js";

export function isSendableChannel(channel: unknown): channel is SendableChannel {
  if (!channel || typeof channel !== "object") return false;
  const record = channel as Record<string, unknown>;
  return typeof record.send === "function";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function firstChunkPayload(content: string, replyToMessageId?: string | null) {
  if (!replyToMessageId) return content;
  return {
    content,
    reply: {
      messageReference: replyToMessageId,
      failIfNotExists: false,
    },
    allowedMentions: {
      repliedUser: false,
    },
  };
}

async function sendChunks(
  channel: SendableChannel,
  chunks: string[],
  replyToMessageId?: string | null,
): Promise<DiscordDeliveryResult> {
  const messageIds: string[] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    try {
      const sent = await channel.send(
        index === 0 ? firstChunkPayload(chunks[index]!, replyToMessageId) : chunks[index]!,
      );
      messageIds.push(sent.id);
    } catch (error) {
      return {
        success: false,
        messageIds,
        deliveredChunks: messageIds.length,
        totalChunks: chunks.length,
        partial: messageIds.length > 0,
        error: errorMessage(error),
      };
    }
  }
  return {
    success: true,
    messageIds,
    deliveredChunks: chunks.length,
    totalChunks: chunks.length,
    partial: false,
    error: null,
  };
}

export async function sendDiscordText(
  channel: SendableChannel,
  text: string,
  options: { replyToMessageId?: string | null } = {},
): Promise<DiscordDeliveryResult> {
  return sendChunks(channel, chunkForDiscord(text), options.replyToMessageId);
}

export async function sendDiscordEmbed(
  channel: SendableChannel,
  embed: APIEmbed,
  fallbackText: string,
  options: {
    components?: unknown[];
    replyToMessageId?: string | null;
  } = {},
): Promise<DiscordDeliveryResult> {
  const reply = options.replyToMessageId
    ? {
        reply: {
          messageReference: options.replyToMessageId,
          failIfNotExists: false,
        },
      }
    : {};
  try {
    const sent = await channel.send({
      embeds: [embed],
      ...(options.components ? { components: options.components } : {}),
      allowedMentions: { parse: [], ...(options.replyToMessageId ? { repliedUser: false } : {}) },
      ...reply,
    });
    return {
      success: true,
      messageIds: [sent.id],
      deliveredChunks: 1,
      totalChunks: 1,
      partial: false,
      error: null,
    };
  } catch (embedError) {
    if (!isEmbedRejection(embedError)) {
      return {
        success: false,
        messageIds: [],
        deliveredChunks: 0,
        totalChunks: 1,
        partial: false,
        error: errorMessage(embedError),
      };
    }
    try {
      const sent = await channel.send({
        content: fallbackText,
        ...(options.components ? { components: options.components } : {}),
        allowedMentions: { parse: [], ...(options.replyToMessageId ? { repliedUser: false } : {}) },
        ...reply,
      });
      return {
        success: true,
        messageIds: [sent.id],
        deliveredChunks: 1,
        totalChunks: 1,
        partial: false,
        error: null,
        usedFallback: true,
      };
    } catch (fallbackError) {
      return {
        success: false,
        messageIds: [],
        deliveredChunks: 0,
        totalChunks: 1,
        partial: false,
        error: `${errorMessage(embedError)}; fallback failed: ${errorMessage(fallbackError)}`,
      };
    }
  }
}

export async function updateDiscordEditableEmbeds(
  channel: SendableChannel,
  state: DiscordEditableEmbedsState,
  embeds: APIEmbed[],
  fallbackTexts: string[],
): Promise<DiscordDeliveryResult> {
  const deliveredIds: string[] = [];
  for (let index = 0; index < embeds.length; index += 1) {
    const embed = embeds[index]!;
    const serialized = JSON.stringify(embed);
    const existingId = state.messageIds[index];
    if (existingId && state.renderedEmbeds[index] === serialized) {
      deliveredIds.push(existingId);
      continue;
    }
    try {
      if (existingId) {
        const message = await channel.messages.fetch(existingId);
        if (state.fallbackIndexes.has(index)) {
          await message.edit(fallbackTexts[index] ?? fallbackTexts.at(-1) ?? "Working…");
        } else {
          await message.edit({ content: null, embeds: [embed] });
        }
        deliveredIds.push(existingId);
      } else {
        const result = await sendDiscordEmbed(
          channel,
          embed,
          fallbackTexts[index] ?? fallbackTexts.at(-1) ?? "Working…",
        );
        if (!result.success || !result.messageIds[0]) {
          throw new Error(result.error ?? "Discord embed delivery failed.");
        }
        state.messageIds[index] = result.messageIds[0];
        if (result.usedFallback) state.fallbackIndexes.add(index);
        deliveredIds.push(result.messageIds[0]);
      }
      state.renderedEmbeds[index] = serialized;
    } catch (error) {
      return {
        success: false,
        messageIds: deliveredIds,
        deliveredChunks: deliveredIds.length,
        totalChunks: embeds.length,
        partial: deliveredIds.length > 0,
        error: errorMessage(error),
      };
    }
  }
  return {
    success: true,
    messageIds: [...state.messageIds],
    deliveredChunks: embeds.length,
    totalChunks: embeds.length,
    partial: false,
    error: null,
  };
}

export async function updateDiscordEditableChunks(
  channel: SendableChannel,
  state: DiscordEditableChunksState,
  text: string,
): Promise<DiscordDeliveryResult> {
  const chunks = chunkForDiscord(text, {
    maxChars: DISCORD_CHUNK_TARGET,
    includePageIndicators: false,
  });
  const deliveredIds: string[] = [];

  for (let index = 0; index < chunks.length; index += 1) {
    const content = chunks[index]!;
    const existingId = state.messageIds[index];
    if (state.renderedChunks[index] === content && existingId) {
      deliveredIds.push(existingId);
      continue;
    }

    try {
      if (existingId) {
        const message = await channel.messages.fetch(existingId);
        await message.edit(content);
        deliveredIds.push(existingId);
      } else {
        const sent = await channel.send(content);
        state.messageIds[index] = sent.id;
        deliveredIds.push(sent.id);
      }
    } catch (error) {
      if (existingId) {
        try {
          const replacement = await channel.send(content);
          state.messageIds[index] = replacement.id;
          deliveredIds.push(replacement.id);
          continue;
        } catch (replacementError) {
          error = replacementError;
        }
      }
      return {
        success: false,
        messageIds: deliveredIds,
        deliveredChunks: deliveredIds.length,
        totalChunks: chunks.length,
        partial: deliveredIds.length > 0,
        error: errorMessage(error),
      };
    }
  }

  state.renderedChunks = chunks;
  return {
    success: true,
    messageIds: [...state.messageIds],
    deliveredChunks: chunks.length,
    totalChunks: chunks.length,
    partial: false,
    error: null,
  };
}

export async function updateDiscordPreview(
  channel: SendableChannel,
  state: DiscordPreviewState,
  text: string,
  options: { finalize?: boolean; replyToMessageId?: string | null } = {},
): Promise<DiscordDeliveryResult> {
  const chunks = chunkForDiscord(text);
  const finalize = options.finalize ?? false;
  if (chunks.length === 0) {
    return {
      success: true,
      messageIds: state.messageId ? [state.messageId] : [],
      deliveredChunks: 0,
      totalChunks: 0,
      partial: false,
      error: null,
    };
  }

  if (!state.messageId) {
    if (finalize) {
      const result = await sendChunks(channel, chunks, options.replyToMessageId);
      state.messageId = result.messageIds[0] ?? null;
      state.continuationMessageIds = result.messageIds.slice(1);
      state.renderedText = chunks[0] ?? "";
      return result;
    }

    const preview = chunks[0]!;
    try {
      const sent = await channel.send(firstChunkPayload(preview, options.replyToMessageId));
      state.messageId = sent.id;
      state.renderedText = preview;
      state.saturatedText = chunks.length > 1 ? preview : null;
      return {
        success: true,
        messageIds: [sent.id],
        deliveredChunks: 1,
        totalChunks: chunks.length,
        partial: chunks.length > 1,
        error: null,
      };
    } catch (error) {
      return {
        success: false,
        messageIds: [],
        deliveredChunks: 0,
        totalChunks: chunks.length,
        partial: false,
        error: errorMessage(error),
      };
    }
  }

  if (!finalize) {
    const preview = chunks[0]!;
    if (state.renderedText === preview || (chunks.length > 1 && state.saturatedText === preview)) {
      return {
        success: true,
        messageIds: [state.messageId],
        deliveredChunks: 1,
        totalChunks: chunks.length,
        partial: chunks.length > 1,
        error: null,
      };
    }

    try {
      const message = await channel.messages.fetch(state.messageId);
      await message.edit(preview);
      state.renderedText = preview;
      state.saturatedText = chunks.length > 1 ? preview : null;
      return {
        success: true,
        messageIds: [state.messageId],
        deliveredChunks: 1,
        totalChunks: chunks.length,
        partial: chunks.length > 1,
        error: null,
      };
    } catch (error) {
      return {
        success: false,
        messageIds: [state.messageId],
        deliveredChunks: 0,
        totalChunks: chunks.length,
        partial: false,
        error: errorMessage(error),
      };
    }
  }

  let originalDelivered = false;
  try {
    const original = await channel.messages.fetch(state.messageId);
    await original.edit(chunks[0]!);
    originalDelivered = true;
    state.renderedText = chunks[0]!;
    state.saturatedText = null;
  } catch {
    const replacement = await sendChunks(channel, chunks, options.replyToMessageId);
    state.messageId = replacement.messageIds[0] ?? state.messageId;
    state.continuationMessageIds = replacement.messageIds.slice(1);
    state.renderedText = chunks[0]!;
    state.saturatedText = null;
    return replacement;
  }

  const continuations = await sendChunks(channel, chunks.slice(1));
  state.continuationMessageIds = continuations.messageIds;
  return {
    success: continuations.success,
    messageIds: [state.messageId, ...continuations.messageIds],
    deliveredChunks: (originalDelivered ? 1 : 0) + continuations.deliveredChunks,
    totalChunks: chunks.length,
    partial: continuations.partial,
    error: continuations.error,
  };
}
