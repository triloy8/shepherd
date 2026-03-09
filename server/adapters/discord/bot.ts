import path from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

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
import type { BridgeEvent, MessagePhase } from "../../../shared/protocol/events.js";
import type { ApprovalPolicy, SandboxMode, WorkspaceTarget } from "../../../shared/protocol/requests.js";
import { loadEnvironment } from "../../config/environment.js";
import { ConversationService } from "../../core/conversation_service.js";
import { handleMessage } from "./commands.js";
import { handleInteraction } from "./interactions.js";
import {
  encodeApprovalButtonId,
  formatApprovalText,
  formatEventLine,
} from "./message_renderer.js";

type StreamState = {
  text: string;
  messageIds: string[];
  renderedChunks: string[];
  lastPhase: MessagePhase | null;
  lastItemId: string | null;
  commentaryOpen: boolean;
  timer: NodeJS.Timeout | null;
  flushing: boolean;
  pendingFlush: boolean;
};

const DISCORD_STREAM_CHUNK_LIMIT = 1900;
const SANDBOX_MODES: SandboxMode[] = ["read-only", "workspace-write", "danger-full-access"];

function readSandboxMode(value: string | undefined): SandboxMode | undefined {
  if (!value) return undefined;
  if (SANDBOX_MODES.includes(value as SandboxMode)) {
    return value as SandboxMode;
  }
  return undefined;
}

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

export function phaseHeader(phase: MessagePhase, hasExistingText: boolean): string {
  const label = phase === "commentary" ? "🧠 Working" : "📦 Final Answer";
  return hasExistingText ? `\n\n**${label}**\n\n` : `**${label}**\n\n`;
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
    channel.type === ChannelType.PrivateThread
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

function parseRepoSlug(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function parseLocalWorkspaceRoot(
  value: string,
): WorkspaceTarget | null {
  const trimmed = value.trim();
  if (trimmed === "~") {
    return {
      kind: "local",
      rootPath: path.join(homedir(), ".agent-workspaces", "local"),
      display: "~",
      appendWorkspaceId: true,
    };
  }
  if (trimmed.startsWith("~/")) {
    return {
      kind: "local",
      rootPath: path.join(homedir(), trimmed.slice(2)),
      display: trimmed,
      appendWorkspaceId: false,
    };
  }
  return null;
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

  const approvalPolicy = (process.env.CODEX_APPROVAL_POLICY ?? "on-request") as ApprovalPolicy;
  const defaultSandbox = readSandboxMode(process.env.CODEX_SANDBOX);

  const conversation = new ConversationService({
    routing: {
      autoCreateIfMissing: true,
      defaultApprovalPolicy: approvalPolicy,
      defaultSandbox,
      exclusiveThreadBinding: true,
    },
  });

  const streamByChannel = new Map<string, StreamState>();
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
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
        lastPhase: null,
        lastItemId: null,
        commentaryOpen: false,
        timer: null,
        flushing: false,
        pendingFlush: false,
      });
      return;
    }

    if (event.type === "turn.stream.delta") {
      const payload = event.payload as {
        textDelta?: string;
        method?: string;
        phase?: MessagePhase | null;
        itemId?: string | null;
      };
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
          lastPhase: null,
          lastItemId: null,
          commentaryOpen: false,
          timer: null,
          flushing: false,
          pendingFlush: false,
        } as StreamState);
      const phase = payload.phase;
      const itemId = payload.itemId ?? null;
      if (state.lastPhase === "commentary" && phase !== "commentary" && state.commentaryOpen) {
        state.text += "*";
        state.commentaryOpen = false;
      }
      if ((phase === "commentary" || phase === "final_answer") && phase !== state.lastPhase) {
        state.text += phaseHeader(phase, state.text.length > 0);
        state.lastPhase = phase;
      }
      if (phase === "commentary") {
        const switchedItem = Boolean(itemId && state.lastItemId && itemId !== state.lastItemId);
        if (switchedItem && state.commentaryOpen) {
          state.text += "*";
          state.commentaryOpen = false;
        }
        if (!state.commentaryOpen) {
          if (!state.text.endsWith("\n")) {
            state.text += "\n";
          }
          state.text += "| *";
          state.commentaryOpen = true;
        }
      }
      state.text += delta;
      if (itemId) {
        state.lastItemId = itemId;
      }
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
      if (state?.commentaryOpen) {
        state.text += "*";
        state.commentaryOpen = false;
      }
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

  const bindChannelToThread = async (channelId: string, threadId: string): Promise<void> => {
    await conversation.bindSurfaceToThread("discord", channelId, threadId);
    conversation.subscribeSurfaceEvents(
      "discord",
      channelId,
      (event) => handleThreadEvent(channelId, event),
      { replay: false },
    );
  };

  const clearChannelThread = (channelId: string): void => {
    conversation.clearSurfaceBinding("discord", channelId);
    conversation.unsubscribeSurfaceEvents("discord", channelId);
  };

  const getChannelRepo = (channelId: string): string | null => {
    return conversation.getSurfaceWorkspaceTarget("discord", channelId)?.display ?? null;
  };

  const createAndBindChannelThread = async (channelId: string): Promise<string> => {
    const created = await conversation.createSurfaceThreadFromContext("discord", channelId, {
      approvalPolicy,
      ...(defaultSandbox ? { sandbox: defaultSandbox } : {}),
    });
    conversation.subscribeSurfaceEvents(
      "discord",
      channelId,
      (event) => handleThreadEvent(channelId, event),
      { replay: false },
    );
    return created.threadId;
  };

  const resumeChannelThread = async (channelId: string, threadId: string): Promise<string> => {
    const resumed = await conversation.resumeSurfaceThreadFromContext("discord", channelId, threadId, {
      ...(defaultSandbox ? { sandbox: defaultSandbox } : {}),
    });
    return resumed.threadId;
  };

  const forkChannelThread = async (channelId: string, sourceThreadId: string): Promise<string> => {
    const forked = await conversation.forkSurfaceThreadFromContext("discord", channelId, sourceThreadId, {
      ...(defaultSandbox ? { sandbox: defaultSandbox } : {}),
    });
    return forked.threadId;
  };

  const ensureChannelThread = async (channelId: string): Promise<string> => {
    const current = conversation.getSurfaceThread("discord", channelId);
    if (current) return current;
    return createAndBindChannelThread(channelId);
  };

  client.once("clientReady", () => {
    console.log(`discord bridge ready as ${client.user?.tag ?? "unknown"}`);
  });

  client.on("messageCreate", async (message) => {
    if (message.author.bot) return;
    if (!isSupportedChannel(message.channel)) return;
    if (!client.user) return;

    const raw = message.content.trim();
    if (!raw) return;
    const isCommand = raw.startsWith("!");
    const isMentioned = message.mentions.users.has(client.user.id);

    if (!isCommand && !isMentioned) {
      return;
    }

    const mentionPattern = new RegExp(`<@!?${client.user.id}>`, "g");
    const sanitizedContent = isCommand ? raw : raw.replace(mentionPattern, "").trim();
    if (!isCommand && !sanitizedContent) return;

    try {
      const result = await handleMessage(message, {
        conversation,
        getActiveThreadId: (channelId) => conversation.getSurfaceThread("discord", channelId),
        getChannelRepo: (channelId) => conversation.getSurfaceWorkspaceTarget("discord", channelId)?.display ?? null,
        setChannelRepo: async (channelId, repoSlug) => {
          const localTarget = parseLocalWorkspaceRoot(repoSlug);
          if (localTarget) {
            conversation.setSurfaceWorkspaceTarget("discord", channelId, localTarget);
            return { repoSlug: localTarget.display };
          }
          const parsed = parseRepoSlug(repoSlug);
          if (!parsed) {
            throw new Error("Invalid repo target. Use `<owner>/<repo>`, `~`, or `~/path`.");
          }
          conversation.setSurfaceWorkspaceTarget("discord", channelId, {
            kind: "github",
            repoSlug: parsed,
            display: parsed,
          });
          return { repoSlug: parsed };
        },
        ensureChannelThread,
        createAndBindChannelThread,
        resumeChannelThread,
        forkChannelThread,
        bindChannelToThread,
        clearChannelThread,
      }, sanitizedContent);

      if (result.handled || !result.threadId || !result.input) return;

      await conversation.submitSurfaceTurn("discord", message.channelId, {
        input: result.input,
        approvalPolicy,
        explicitThreadId: result.threadId,
        autoSteerActiveTurn: !isCommand && isMentioned,
      });
    } catch (error) {
      await message.reply(error instanceof Error ? error.message : "Failed to process message.");
    }
  });

  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isButton()) return;
    await handleInteraction(interaction, conversation);
  });

  await client.login(token);

  const shutdown = async (): Promise<void> => {
    conversation.stopAll();
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
