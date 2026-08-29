import {
  MessageFlags,
  type MessageCreateOptions,
  type MessageEditOptions,
  type TextBasedChannel,
} from "discord.js";
import type { Buffer } from "node:buffer";

import {
  buildCardPages,
  buildMarkdownPages,
  componentsV2Payload,
  type DiscordSurfacePage,
  type SurfaceTone,
} from "./components_renderer.js";
import {
  chunkForDiscord,
  DISCORD_CHUNK_TARGET,
  DISCORD_MESSAGE_LIMIT,
} from "./chunking.js";

export type DiscordMessage = {
  id: string;
  edit: (content: MessageEditOptions) => Promise<unknown>;
};

export type DiscordFileAttachment = {
  attachment: Buffer;
  name: string;
  description?: string;
};

export type SendableChannel = TextBasedChannel & {
  send: (content: MessageCreateOptions) => Promise<DiscordMessage>;
  sendTyping?: () => Promise<unknown>;
  messages: { fetch: (id: string) => Promise<DiscordMessage> };
};

export type DiscordReplyTarget = {
  id: string;
  channel: unknown;
  reply: (content: MessageCreateOptions) => Promise<DiscordMessage>;
};

export type DiscordDeliveryResult = {
  success: boolean;
  messageIds: string[];
  deliveredChunks: number;
  totalChunks: number;
  partial: boolean;
  error: string | null;
};

export type DiscordEditableSurfaceState = {
  messageIds: string[];
  renderedPages: string[];
};

export type DiscordPreviewState = {
  messageId: string | null;
  renderedPage: string;
  continuationMessageIds: string[];
};

export function createDiscordEditableSurfaceState(): DiscordEditableSurfaceState {
  return { messageIds: [], renderedPages: [] };
}

export function createDiscordPreviewState(): DiscordPreviewState {
  return {
    messageId: null,
    renderedPage: "",
    continuationMessageIds: [],
  };
}

export { chunkForDiscord, DISCORD_CHUNK_TARGET, DISCORD_MESSAGE_LIMIT } from "./chunking.js";

export function isSendableChannel(channel: unknown): channel is SendableChannel {
  if (!channel || typeof channel !== "object") return false;
  return typeof (channel as Record<string, unknown>).send === "function";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function serializePage(page: DiscordSurfacePage): string {
  return JSON.stringify(
    page.components.map((component) =>
      component && typeof component === "object" && "toJSON" in component
        ? (component as { toJSON: () => unknown }).toJSON()
        : component,
    ),
  );
}

async function sendSurfacePages(
  pages: DiscordSurfacePage[],
  sendFirst: (payload: MessageCreateOptions) => Promise<DiscordMessage>,
  sendContinuation: (payload: MessageCreateOptions) => Promise<DiscordMessage>,
  options: { replyToMessageId?: string | null } = {},
): Promise<DiscordDeliveryResult> {
  const messageIds: string[] = [];

  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index]!;
    const send = index === 0 ? sendFirst : sendContinuation;
    try {
      const sent = await send(
        componentsV2Payload(page, {
          replyToMessageId: index === 0 ? options.replyToMessageId : null,
        }),
      );
      messageIds.push(sent.id);
    } catch (error) {
      return {
        success: false,
        messageIds,
        deliveredChunks: messageIds.length,
        totalChunks: pages.length,
        partial: messageIds.length > 0,
        error: errorMessage(error),
      };
    }
  }

  return {
    success: true,
    messageIds,
    deliveredChunks: pages.length,
    totalChunks: pages.length,
    partial: false,
    error: null,
  };
}

export async function sendDiscordPages(
  channel: SendableChannel,
  pages: DiscordSurfacePage[],
  options: { replyToMessageId?: string | null } = {},
): Promise<DiscordDeliveryResult> {
  return sendSurfacePages(
    pages,
    (payload) => channel.send(payload),
    (payload) => channel.send(payload),
    options,
  );
}

export async function sendDiscordMarkdown(
  channel: SendableChannel,
  text: string,
  options: { replyToMessageId?: string | null } = {},
): Promise<DiscordDeliveryResult> {
  return sendDiscordPages(channel, buildMarkdownPages(text), options);
}

export async function replyDiscordPages(
  target: DiscordReplyTarget,
  pages: DiscordSurfacePage[],
): Promise<DiscordDeliveryResult> {
  const channel = target.channel;
  if (pages.length > 1 && !isSendableChannel(channel)) {
    return {
      success: false,
      messageIds: [],
      deliveredChunks: 0,
      totalChunks: pages.length,
      partial: false,
      error: "Discord channel cannot send messages.",
    };
  }
  return sendSurfacePages(
    pages,
    (payload) => target.reply(payload),
    (payload) => {
      if (!isSendableChannel(channel)) throw new Error("Discord channel cannot send messages.");
      return channel.send(payload);
    },
  );
}

export async function replyDiscordMarkdown(
  target: DiscordReplyTarget,
  text: string,
): Promise<DiscordDeliveryResult> {
  return replyDiscordPages(target, buildMarkdownPages(text));
}

export async function replyDiscordCard(
  target: DiscordReplyTarget,
  options: { title: string; text: string; tone?: SurfaceTone },
): Promise<DiscordDeliveryResult> {
  return replyDiscordPages(target, buildCardPages(options));
}

export async function updateDiscordEditableSurfaces(
  channel: SendableChannel,
  state: DiscordEditableSurfaceState,
  pages: DiscordSurfacePage[],
): Promise<DiscordDeliveryResult> {
  const deliveredIds: string[] = [];

  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index]!;
    const serialized = serializePage(page);
    const existingId = state.messageIds[index];
    if (existingId && state.renderedPages[index] === serialized) {
      deliveredIds.push(existingId);
      continue;
    }

    try {
      if (existingId) {
        const message = await channel.messages.fetch(existingId);
        await message.edit({
          flags: MessageFlags.IsComponentsV2,
          components: page.components,
          allowedMentions: { parse: [] },
        });
        deliveredIds.push(existingId);
      } else {
        const result = await sendDiscordPages(channel, [page]);
        if (!result.success || !result.messageIds[0]) {
          throw new Error(result.error ?? "Discord Components V2 delivery failed.");
        }
        state.messageIds[index] = result.messageIds[0];
        deliveredIds.push(result.messageIds[0]);
      }
      state.renderedPages[index] = serialized;
    } catch (error) {
      return {
        success: false,
        messageIds: deliveredIds,
        deliveredChunks: deliveredIds.length,
        totalChunks: pages.length,
        partial: deliveredIds.length > 0,
        error: errorMessage(error),
      };
    }
  }

  return {
    success: true,
    messageIds: [...state.messageIds],
    deliveredChunks: pages.length,
    totalChunks: pages.length,
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
  const pages = buildMarkdownPages(text, { maxChars: DISCORD_CHUNK_TARGET });
  if (pages.length === 0) {
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
    const initialPages = options.finalize ? pages : pages.slice(0, 1);
    const result = await sendDiscordPages(channel, initialPages, {
      replyToMessageId: options.replyToMessageId,
    });
    state.messageId = result.messageIds[0] ?? null;
    state.continuationMessageIds = result.messageIds.slice(1);
    state.renderedPage = serializePage(pages[0]!);
    return {
      ...result,
      totalChunks: pages.length,
      partial: !options.finalize && pages.length > 1,
    };
  }

  const first = pages[0]!;
  const serialized = serializePage(first);
  try {
    if (state.renderedPage !== serialized) {
      const message = await channel.messages.fetch(state.messageId);
      await message.edit({
        flags: MessageFlags.IsComponentsV2,
        components: first.components,
        allowedMentions: { parse: [] },
      });
      state.renderedPage = serialized;
    }
  } catch (error) {
    return {
      success: false,
      messageIds: [state.messageId],
      deliveredChunks: 0,
      totalChunks: pages.length,
      partial: false,
      error: errorMessage(error),
    };
  }

  if (!options.finalize) {
    return {
      success: true,
      messageIds: [state.messageId],
      deliveredChunks: 1,
      totalChunks: pages.length,
      partial: pages.length > 1,
      error: null,
    };
  }

  const continuations = await sendDiscordPages(channel, pages.slice(1));
  state.continuationMessageIds = continuations.messageIds;
  return {
    success: continuations.success,
    messageIds: [state.messageId, ...continuations.messageIds],
    deliveredChunks: 1 + continuations.deliveredChunks,
    totalChunks: pages.length,
    partial: continuations.partial,
    error: continuations.error,
  };
}
