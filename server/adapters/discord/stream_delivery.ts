import type { TextBasedChannel } from "discord.js";

import type { ResponseStreamState } from "../../core/response_stream_reducer.js";

export type DiscordStreamState = {
  stream: ResponseStreamState;
  messageIds: string[];
  renderedChunks: string[];
  timer: NodeJS.Timeout | null;
  flushing: boolean;
  pendingFlush: boolean;
};

export type SendableChannel = TextBasedChannel & {
  send: (content: string | { content: string; components?: unknown[] }) => Promise<{ id: string }>;
  messages: { fetch: (id: string) => Promise<{ edit: (content: string) => Promise<unknown> }> };
};

export const DISCORD_STREAM_CHUNK_LIMIT = 1900;

export function createDiscordStreamState(stream: ResponseStreamState): DiscordStreamState {
  return {
    stream,
    messageIds: [],
    renderedChunks: [],
    timer: null,
    flushing: false,
    pendingFlush: false,
  };
}

export function chunkForDiscord(text: string, maxChunkSize = DISCORD_STREAM_CHUNK_LIMIT): string[] {
  if (!text) return [];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxChunkSize) {
    const slice = remaining.slice(0, maxChunkSize);
    const breakAt = Math.max(slice.lastIndexOf("\n"), slice.lastIndexOf(" "));
    const boundary = breakAt >= Math.floor(maxChunkSize * 0.6) ? breakAt + 1 : maxChunkSize;
    chunks.push(remaining.slice(0, boundary));
    remaining = remaining.slice(boundary);
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

export function isSendableChannel(channel: unknown): channel is SendableChannel {
  if (!channel || typeof channel !== "object") return false;
  const record = channel as Record<string, unknown>;
  return typeof record.send === "function";
}

export async function flushDiscordStream(
  channel: SendableChannel,
  state: DiscordStreamState,
): Promise<void> {
  const chunks = chunkForDiscord(state.stream.text);
  for (let index = 0; index < chunks.length; index += 1) {
    const content = chunks[index]!;
    const prior = state.renderedChunks[index];

    if (prior === content) {
      continue;
    }

    const existingMessageId = state.messageIds[index];
    if (existingMessageId) {
      try {
        const message = await channel.messages.fetch(existingMessageId);
        await message.edit(content);
      } catch {
        const sent = await channel.send(content);
        state.messageIds[index] = sent.id;
      }
    } else {
      const sent = await channel.send(content);
      state.messageIds[index] = sent.id;
    }
  }

  state.renderedChunks = chunks;
}
