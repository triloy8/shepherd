import type { Message } from "discord.js";

import type { SessionManager } from "../../core/session_manager.js";
import type { ThreadStore } from "./thread_store.js";

type HandleResult = { handled: boolean; threadId: string | null; input: string | null };
const DISCORD_MESSAGE_LIMIT = 1900;

export type CommandContext = {
  manager: SessionManager;
  store: ThreadStore;
  ensureChannelThread: (channelId: string) => Promise<string>;
  createAndBindChannelThread: (channelId: string) => Promise<string>;
  bindChannelToThread: (channelId: string, threadId: string) => Promise<void>;
  clearChannelThread: (channelId: string) => void;
};

function formatTimestamp(seconds: number | null): string {
  if (!seconds) return "unknown";
  return new Date(seconds * 1000).toISOString();
}

function parseThreadArgs(content: string): { command: string; args: string[] } {
  const [command, ...rest] = content.split(/\s+/);
  return { command: command.toLowerCase(), args: rest };
}

function chunkForDiscord(text: string, maxChunkSize = DISCORD_MESSAGE_LIMIT): string[] {
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

function isSendableChannel(
  channel: unknown,
): channel is { send: (content: string) => Promise<unknown> } {
  if (!channel || typeof channel !== "object") return false;
  const record = channel as Record<string, unknown>;
  return typeof record.send === "function";
}

async function replyChunked(message: Message, text: string): Promise<void> {
  const chunks = chunkForDiscord(text);
  if (chunks.length === 0) return;

  await message.reply(chunks[0]!);
  if (!isSendableChannel(message.channel)) return;
  for (const chunk of chunks.slice(1)) {
    await message.channel.send(chunk);
  }
}

async function listStoredThreads(message: Message, context: CommandContext, archived: boolean): Promise<void> {
  const result = await context.manager.listStoredThreads({ archived, limit: 25 });
  if (result.threads.length === 0) {
    await message.reply(archived ? "No archived threads." : "No active threads.");
    return;
  }

  const lines = result.threads.map((thread, index) => {
    const label = thread.name ?? (thread.preview.slice(0, 48) || "untitled");
    return `${index + 1}. ${thread.threadId} | ${label} | updated ${formatTimestamp(thread.updatedAt)}`;
  });
  await replyChunked(message, lines.join("\n"));
}

export async function handleMessage(message: Message, context: CommandContext): Promise<HandleResult> {
  if (!message.content.trim()) {
    return { handled: true, threadId: null, input: null };
  }

  const content = message.content.trim();
  const channelId = message.channelId;
  const { command, args } = parseThreadArgs(content);

  if (command === "!help") {
    await message.reply([
      "Discord Shepherd commands:",
      "- !help",
      "- !newthread",
      "- !threads",
      "- !threads loaded",
      "- !threads archived",
      "- !thread",
      "- !thread <id>",
      "- !threadname <name>",
      "- !threadread [id]",
      "- !fork [id]",
      "- !archive [id]",
      "- !unarchive <id>",
      "- !rollback <numTurns> [id]",
      "- !compact [id]",
      "Any other message is sent as a Shepherd turn.",
    ].join("\n"));
    return { handled: true, threadId: null, input: null };
  }

  if (command === "!threads") {
    const mode = (args[0] ?? "").toLowerCase();
    if (mode === "loaded") {
      const loaded = await context.manager.listLoadedThreads({ limit: 100 });
      await replyChunked(
        message,
        loaded.threadIds.length > 0
          ? `Loaded threads (${loaded.threadIds.length}):\n${loaded.threadIds.join("\n")}`
          : "No loaded threads.",
      );
      return { handled: true, threadId: null, input: null };
    }

    await listStoredThreads(message, context, mode === "archived");
    return { handled: true, threadId: null, input: null };
  }

  if (command === "!newthread") {
    const threadId = await context.createAndBindChannelThread(channelId);
    await message.reply(`Started new thread: ${threadId}`);
    return { handled: true, threadId, input: null };
  }

  if (command === "!thread" && args.length === 0) {
    const existing = context.store.getThreadId(channelId);
    await message.reply(existing ? `Current thread: ${existing}` : "No thread yet. Send a message to start one.");
    return { handled: true, threadId: existing, input: null };
  }

  if (command === "!thread" && args.length > 0) {
    const requestedThreadId = args[0]?.trim();
    if (!requestedThreadId) {
      await message.reply("Usage: !thread <id>");
      return { handled: true, threadId: null, input: null };
    }

    let resolvedThreadId = requestedThreadId;
    try {
      context.manager.getThreadState(requestedThreadId);
    } catch {
      const resumed = await context.manager.resumeThread(requestedThreadId, {});
      resolvedThreadId = resumed.threadId;
    }

    await context.bindChannelToThread(channelId, resolvedThreadId);
    await message.reply(`Switched active thread to: ${resolvedThreadId}`);
    return { handled: true, threadId: resolvedThreadId, input: null };
  }

  if (command === "!threadname") {
    const name = args.join(" ").trim();
    if (!name) {
      await message.reply("Usage: !threadname <name>");
      return { handled: true, threadId: null, input: null };
    }
    const threadId = context.store.getThreadId(channelId);
    if (!threadId) {
      await message.reply("No active thread in this channel.");
      return { handled: true, threadId: null, input: null };
    }
    await context.manager.setThreadName(threadId, { name });
    await replyChunked(message, `Thread renamed: ${name}`);
    return { handled: true, threadId, input: null };
  }

  if (command === "!threadread") {
    const threadId = args[0] ?? context.store.getThreadId(channelId);
    if (!threadId) {
      await message.reply("Usage: !threadread <id>");
      return { handled: true, threadId: null, input: null };
    }
    const result = await context.manager.readThread(threadId, { includeTurns: false });
    const thread = result.thread as { id?: string; name?: string | null; preview?: string; updatedAt?: number | null };
    await replyChunked(message, [
      `Thread: ${thread.id ?? threadId}`,
      `Name: ${thread.name ?? "untitled"}`,
      `Updated: ${formatTimestamp(typeof thread.updatedAt === "number" ? thread.updatedAt : null)}`,
      `Preview: ${(thread.preview ?? "").slice(0, 300) || "(empty)"}`,
    ].join("\n"));
    return { handled: true, threadId, input: null };
  }

  if (command === "!fork") {
    const sourceThreadId = args[0] ?? context.store.getThreadId(channelId);
    if (!sourceThreadId) {
      await message.reply("Usage: !fork <id>");
      return { handled: true, threadId: null, input: null };
    }
    const forked = await context.manager.forkThread(sourceThreadId, {});
    await context.bindChannelToThread(channelId, forked.threadId);
    await message.reply(`Forked thread ${sourceThreadId} -> ${forked.threadId}`);
    return { handled: true, threadId: forked.threadId, input: null };
  }

  if (command === "!archive") {
    const target = args[0] ?? context.store.getThreadId(channelId);
    if (!target) {
      await message.reply("Usage: !archive <id>");
      return { handled: true, threadId: null, input: null };
    }
    await context.manager.archiveThread(target);
    if (context.store.getThreadId(channelId) === target) {
      context.clearChannelThread(channelId);
    }
    await message.reply(`Archived thread: ${target}`);
    return { handled: true, threadId: target, input: null };
  }

  if (command === "!unarchive") {
    const target = args[0];
    if (!target) {
      await message.reply("Usage: !unarchive <id>");
      return { handled: true, threadId: null, input: null };
    }
    await context.manager.unarchiveThread(target);
    await message.reply(`Unarchived thread: ${target}`);
    return { handled: true, threadId: target, input: null };
  }

  if (command === "!rollback") {
    const numTurns = Number(args[0]);
    const target = args[1] ?? context.store.getThreadId(channelId);
    if (!Number.isInteger(numTurns) || numTurns < 1 || !target) {
      await message.reply("Usage: !rollback <numTurns> [id]");
      return { handled: true, threadId: null, input: null };
    }
    await context.manager.rollbackThread(target, { numTurns });
    await message.reply(`Rolled back ${numTurns} turn(s) on ${target}`);
    return { handled: true, threadId: target, input: null };
  }

  if (command === "!compact") {
    const target = args[0] ?? context.store.getThreadId(channelId);
    if (!target) {
      await message.reply("Usage: !compact <id>");
      return { handled: true, threadId: null, input: null };
    }
    await context.manager.compactThread(target);
    await message.reply(`Started compaction for thread: ${target}`);
    return { handled: true, threadId: target, input: null };
  }

  const threadId = await context.ensureChannelThread(channelId);
  return { handled: false, threadId, input: content };
}
