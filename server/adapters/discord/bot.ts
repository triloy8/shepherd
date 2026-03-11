import path from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

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
import type { ApprovalPolicy, SandboxMode } from "../../../shared/protocol/requests.js";
import { loadEnvironment } from "../../config/environment.js";
import { ConversationService } from "../../core/conversation_service.js";
import { SurfaceConversationOrchestrator } from "../../core/surface_conversation_orchestrator.js";
import { SurfaceStateService } from "../../core/surface_state_service.js";
import { WorkspaceProvisioner } from "../../core/workspace_provisioner.js";
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
  commentaryLineStart: boolean;
  timer: NodeJS.Timeout | null;
  flushing: boolean;
  pendingFlush: boolean;
};

const execFileAsync = promisify(execFile);

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
  if (phase === "commentary") {
    return "";
  }
  return hasExistingText ? '\n\n' : "";
}

export function formatCommentaryDelta(delta: string, atLineStart: boolean): {
  text: string;
  endsAtLineStart: boolean;
} {
  if (!delta) {
    return { text: "", endsAtLineStart: atLineStart };
  }

  const lines = delta.split("\n");
  let text = "";

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const isLast = index === lines.length - 1;
    const needsPrefix = index === 0 ? atLineStart : true;

    if (isLast) {
      if (!delta.endsWith("\n")) {
        text += `${needsPrefix ? "> " : ""}${line}`;
      }
      continue;
    }

    text += `${needsPrefix ? "> " : ""}${line}\n`;
  }

  return {
    text,
    endsAtLineStart: delta.endsWith("\n"),
  };
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

function repoNameFromSlug(slug: string): string {
  return slug.split("/")[1] ?? slug;
}

async function runGh(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("gh", args, {
      cwd: process.cwd(),
      env: process.env,
      maxBuffer: 1024 * 1024 * 10,
    });
    return stdout.trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`gh ${args.join(" ")} failed: ${message}`);
  }
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
  const surfaceState = new SurfaceStateService();
  const workspaceProvisioner = new WorkspaceProvisioner({
    async cloneGithubRepo(slug, workspacePath) {
      await runGh(["repo", "clone", slug, workspacePath, "--", "--recurse-submodules"]);
    },
  });

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
        commentaryLineStart: true,
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
          commentaryLineStart: true,
          timer: null,
          flushing: false,
          pendingFlush: false,
        } as StreamState);
      const phase = payload.phase;
      const itemId = payload.itemId ?? null;
      if (state.lastPhase === "commentary" && phase !== "commentary" && state.commentaryOpen) {
        state.commentaryOpen = false;
        state.commentaryLineStart = true;
      }
      if ((phase === "commentary" || phase === "final_answer") && phase !== state.lastPhase) {
        state.text += phaseHeader(phase, state.text.length > 0);
        state.lastPhase = phase;
      }
      if (phase === "commentary") {
        const switchedItem = Boolean(itemId && state.lastItemId && itemId !== state.lastItemId);
        if (switchedItem && state.commentaryOpen) {
          if (!state.text.endsWith("\n")) {
            state.text += "\n";
          }
          state.commentaryOpen = false;
          state.commentaryLineStart = true;
        }
        if (!state.commentaryOpen) {
          if (!state.text.endsWith("\n")) {
            state.text += "\n";
          }
          state.commentaryOpen = true;
          state.commentaryLineStart = true;
        }
        const formatted = formatCommentaryDelta(delta, state.commentaryLineStart);
        state.text += formatted.text;
        state.commentaryLineStart = formatted.endsAtLineStart;
      } else {
        state.text += delta;
      }
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
        state.commentaryOpen = false;
        state.commentaryLineStart = true;
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

  const orchestrator = new SurfaceConversationOrchestrator(
    conversation,
    surfaceState,
    workspaceProvisioner,
    {
      adapter: "discord",
      approvalPolicy,
      sandbox: defaultSandbox,
      projectTargetResolver: {
        resolveGithubRepo: async (slug) =>
          runGh(["repo", "view", slug, "--json", "nameWithOwner", "--jq", ".nameWithOwner"]),
      },
    },
  );

  const bindChannelToThread = async (surfaceId: string, threadId: string): Promise<void> => {
    await orchestrator.bindSurfaceToThread(surfaceId, threadId, (event) => handleThreadEvent(surfaceId, event));
  };

  const clearSurfaceThread = (surfaceId: string): void => {
    orchestrator.clearSurfaceThread(surfaceId);
  };

  const createSurfaceThread = async (surfaceId: string): Promise<string> => {
    return orchestrator.createAndBindSurfaceThread(surfaceId, (event) => handleThreadEvent(surfaceId, event));
  };

  const forkSurfaceThread = async (surfaceId: string, sourceThreadId: string): Promise<string> => {
    return orchestrator.forkSurfaceThread(surfaceId, sourceThreadId, (event) => handleThreadEvent(surfaceId, event));
  };

  const switchSurfaceThread = async (surfaceId: string, threadId: string): Promise<string> => {
    return orchestrator.switchSurfaceThread(surfaceId, threadId, (event) => handleThreadEvent(surfaceId, event));
  };

  const ensureSurfaceThread = async (surfaceId: string): Promise<string> => {
    return orchestrator.ensureSurfaceThread(surfaceId, (event) => handleThreadEvent(surfaceId, event));
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
        getSurfaceThreadId: (surfaceId) => conversation.getSurfaceThread("discord", surfaceId),
        getSurfaceProject: (surfaceId) => orchestrator.getSurfaceProjectDisplay(surfaceId),
        setSurfaceProject: async (surfaceId, repoSlug) => orchestrator.setSurfaceProject(surfaceId, repoSlug),
        ensureSurfaceThread,
        createSurfaceThread,
        switchSurfaceThread,
        forkSurfaceThread,
        clearSurfaceThread,
      }, sanitizedContent);

      if (result.handled || !result.threadId || !result.input) return;

      if (!isCommand && isMentioned) {
        const state = conversation.getThreadState(result.threadId);
        if (state.activeTurnId) {
          await conversation.steerTurn(result.threadId, {
            input: result.input,
            turnId: state.activeTurnId,
          });
          return;
        }
      }

      await conversation.submitTurn(result.threadId, {
        input: result.input,
        approvalPolicy,
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
