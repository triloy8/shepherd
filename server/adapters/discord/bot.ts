import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  GatewayIntentBits,
  type Message,
  type TextBasedChannel,
} from "discord.js";

import type { ApprovalRequestPayload } from "../../../shared/protocol/approvals.js";
import type { BridgeEvent } from "../../../shared/protocol/events.js";
import type { ApprovalPolicy } from "../../../shared/protocol/requests.js";
import { loadEnvironment } from "../../config/environment.js";
import { SessionManager } from "../../core/session_manager.js";
import { handleMessage } from "./commands.js";
import { handleInteraction } from "./interactions.js";
import {
  encodeApprovalButtonId,
  formatApprovalText,
  formatEventLine,
} from "./message_renderer.js";
import { ThreadStore } from "./thread_store.js";

type StreamState = {
  text: string;
  messageIds: string[];
  renderedChunks: string[];
  timer: NodeJS.Timeout | null;
  flushing: boolean;
  pendingFlush: boolean;
};

const DISCORD_STREAM_CHUNK_LIMIT = 1900;

function chunkForDiscord(text: string, maxChunkSize = DISCORD_STREAM_CHUNK_LIMIT): string[] {
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

function pickButtonStyle(decision: string): ButtonStyle {
  const normalized = decision.toLowerCase();
  if (normalized.includes("accept") || normalized.includes("approve") || normalized === "success") {
    return ButtonStyle.Success;
  }
  if (normalized.includes("decline") || normalized.includes("deny") || normalized.includes("reject") || normalized === "failure") {
    return ButtonStyle.Danger;
  }
  return ButtonStyle.Secondary;
}

function buildApprovalRows(
  threadId: string,
  approval: ApprovalRequestPayload,
): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  let current = new ActionRowBuilder<ButtonBuilder>();
  let count = 0;

  for (const choice of approval.choices) {
    if (count === 5) {
      rows.push(current);
      current = new ActionRowBuilder<ButtonBuilder>();
      count = 0;
    }

    current.addComponents(
      new ButtonBuilder()
        .setCustomId(encodeApprovalButtonId(threadId, approval.approvalId, choice.value))
        .setLabel(choice.label)
        .setStyle(pickButtonStyle(choice.value)),
    );
    count += 1;
  }

  if (count > 0) {
    rows.push(current);
  }

  return rows;
}

function isSupportedChannel(channel: Message["channel"]): channel is TextBasedChannel {
  return (
    channel.type === ChannelType.GuildText ||
    channel.type === ChannelType.PublicThread ||
    channel.type === ChannelType.PrivateThread ||
    channel.type === ChannelType.DM
  );
}

function isSendableChannel(channel: unknown): channel is TextBasedChannel & {
  send: (content: string | { content: string; components?: ActionRowBuilder<ButtonBuilder>[] }) => Promise<{ id: string }>;
  messages: { fetch: (id: string) => Promise<{ edit: (content: string) => Promise<unknown> }> };
} {
  if (!channel || typeof channel !== "object") return false;
  const record = channel as Record<string, unknown>;
  return typeof record.send === "function";
}

async function sendChannelMessage(client: Client, channelId: string, text: string): Promise<void> {
  const channel = await client.channels.fetch(channelId);
  if (!isSendableChannel(channel)) return;
  await channel.send(text);
}

export async function startDiscordBot(): Promise<void> {
  loadEnvironment("discord");
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    throw new Error("Missing DISCORD_BOT_TOKEN.");
  }

  const approvalPolicy = (process.env.DISCORD_APPROVAL_POLICY ?? "on-request") as ApprovalPolicy;

  const manager = new SessionManager();
  const store = new ThreadStore();

  const channelByThread = new Map<string, string>();
  const unsubscribeByChannel = new Map<string, () => void>();
  const streamByChannel = new Map<string, StreamState>();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  const flushStream = async (channelId: string): Promise<void> => {
    const state = streamByChannel.get(channelId);
    if (!state || !state.text.trim()) return;
    if (state.flushing) {
      state.pendingFlush = true;
      return;
    }
    state.flushing = true;

    try {
      const channel = await client.channels.fetch(channelId);
      if (!isSendableChannel(channel)) return;

      const chunks = chunkForDiscord(state.text);
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
    } finally {
      state.flushing = false;
      if (state.pendingFlush) {
        state.pendingFlush = false;
        queueMicrotask(() => {
          void flushStream(channelId);
        });
      }
    }
  };

  const scheduleStreamFlush = (channelId: string): void => {
    const state = streamByChannel.get(channelId);
    if (!state || state.timer) return;

    state.timer = setTimeout(() => {
      state.timer = null;
      void flushStream(channelId);
    }, 400);
  };

  const handleThreadEvent = (channelId: string, event: BridgeEvent): void => {
    if (event.type === "turn.started") {
      const prior = streamByChannel.get(channelId);
      if (prior?.timer) clearTimeout(prior.timer);
      streamByChannel.set(channelId, {
        text: "",
        messageIds: [],
        renderedChunks: [],
        timer: null,
        flushing: false,
        pendingFlush: false,
      });
      return;
    }

    if (event.type === "turn.stream.delta") {
      const payload = event.payload as { textDelta?: string; method?: string };
      const method = payload.method?.toLowerCase() ?? "";
      if (method && !method.includes("agentmessage")) {
        return;
      }
      const delta = payload.textDelta ?? "";
      if (!delta) return;

      const state =
        streamByChannel.get(channelId) ??
        ({
          text: "",
          messageIds: [],
          renderedChunks: [],
          timer: null,
          flushing: false,
          pendingFlush: false,
        } as StreamState);
      state.text += delta;
      streamByChannel.set(channelId, state);
      scheduleStreamFlush(channelId);
      return;
    }

    if (event.type === "approval.requested") {
      const approval = event.payload as ApprovalRequestPayload;
      void (async () => {
        const channel = await client.channels.fetch(channelId);
        if (!isSendableChannel(channel)) return;
        await channel.send({
          content: formatApprovalText(approval),
          components: buildApprovalRows(event.threadId, approval),
        });
      })();
      return;
    }

    if (event.type === "turn.completed" || event.type === "turn.failed") {
      const state = streamByChannel.get(channelId);
      if (state?.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      void flushStream(channelId);
    }

    const line = formatEventLine(event);
    if (line) {
      void sendChannelMessage(client, channelId, line);
    }
  };

  const ensureChannelThread = async (channelId: string): Promise<string> => {
    const existing = store.getThreadId(channelId);
    if (existing) return existing;

    const created = await manager.createThread(approvalPolicy);
    store.setThreadId(channelId, created.threadId);
    channelByThread.set(created.threadId, channelId);

    const unsubscribe = manager.subscribeToThreadEvents(
      created.threadId,
      (event) => handleThreadEvent(channelId, event),
    );

    const previous = unsubscribeByChannel.get(channelId);
    if (previous) previous();
    unsubscribeByChannel.set(channelId, unsubscribe);

    return created.threadId;
  };

  client.once("clientReady", () => {
    console.log(`discord bridge ready as ${client.user?.tag ?? "unknown"}`);
  });

  client.on("messageCreate", async (message) => {
    if (message.author.bot) return;
    if (!isSupportedChannel(message.channel)) return;

    try {
      const result = await handleMessage(message, {
        manager,
        store,
        ensureChannelThread,
      });

      if (result.handled || !result.threadId || !result.input) return;

      await manager.submitTurn(result.threadId, {
        input: result.input,
        approvalPolicy,
      });
    } catch (error) {
      await message.reply(error instanceof Error ? error.message : "Failed to process message.");
    }
  });

  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isButton()) return;
    await handleInteraction(interaction, manager);
  });

  await client.login(token);

  const shutdown = async (): Promise<void> => {
    for (const unsubscribe of unsubscribeByChannel.values()) {
      unsubscribe();
    }
    manager.stopAll();
    await client.destroy();
  };

  process.on("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });
}

const __filename = fileURLToPath(import.meta.url);
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === __filename;

if (isDirectRun) {
  void startDiscordBot().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
