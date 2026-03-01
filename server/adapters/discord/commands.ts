import type { Message } from "discord.js";

import type { SessionManager } from "../../core/session_manager.js";

type HandleResult = { handled: boolean; threadId: string | null; input: string | null };
const DISCORD_MESSAGE_LIMIT = 1900;
const CODEX_CONTEXT_BASELINE_TOKENS = 12_000;

export type CommandContext = {
  manager: SessionManager;
  getActiveThreadId: (channelId: string) => string | null;
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

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function formatNumber(value: unknown): string {
  const num = asNumber(value);
  return num === null ? "unknown" : num.toLocaleString();
}

function formatResetTimestamp(seconds: unknown): string {
  const timestamp = asNumber(seconds);
  if (timestamp === null) return "unknown";
  return `<t:${Math.floor(timestamp)}:f> (<t:${Math.floor(timestamp)}:R>)`;
}

function formatWindow(label: string, value: unknown): string {
  const data = asRecord(value);
  const used = asNumber(data.usedPercent);
  const duration = asNumber(data.windowDurationMins);
  const reset = formatResetTimestamp(data.resetsAt);
  return [
    `**${label}**`,
    `- Used: ${used === null ? "unknown" : `${used}%`}`,
    `- Window: ${duration === null ? "unknown" : `${duration} min`}`,
    `- Resets: ${reset}`,
  ].join("\n");
}

function formatRateLimitsForDiscord(value: unknown): string {
  const limits = asRecord(value);
  const planType = asString(limits.planType) ?? "unknown";
  const limitId = asString(limits.limitId) ?? "unknown";

  const credits = asRecord(limits.credits);
  const hasCredits = credits.hasCredits === true ? "yes" : "no";
  const unlimited = credits.unlimited === true ? "yes" : "no";
  const balance = asString(credits.balance) ?? "unknown";

  const lines = [
    `**Rate Limits**`,
    `- Plan: ${planType}`,
    `- Limit ID: ${limitId}`,
    "",
    formatWindow("Primary Window", limits.primary),
    "",
    formatWindow("Secondary Window", limits.secondary),
    "",
    `**Credits**`,
    `- Has credits: ${hasCredits}`,
    `- Unlimited: ${unlimited}`,
    `- Balance: ${balance}`,
  ];

  if (!limits.primary && !limits.secondary) {
    lines.push("", "Raw payload:", "```json", safeJson(value), "```");
  }

  return lines.join("\n");
}

function formatThreadContextForDiscord(threadId: string, tokenUsage: unknown): string {
  const usage = asRecord(tokenUsage);
  const last = asRecord(usage.last);
  const total = asRecord(usage.total);
  const contextWindow = asNumber(usage.modelContextWindow);

  const lastTotalTokens = asNumber(last.totalTokens);
  const effectiveWindow =
    contextWindow !== null ? Math.max(contextWindow - CODEX_CONTEXT_BASELINE_TOKENS, 0) : null;
  const usedInEffectiveWindow =
    effectiveWindow !== null && lastTotalTokens !== null
      ? Math.max(lastTotalTokens - CODEX_CONTEXT_BASELINE_TOKENS, 0)
      : null;
  const remainingInEffectiveWindow =
    effectiveWindow !== null && usedInEffectiveWindow !== null
      ? Math.max(effectiveWindow - usedInEffectiveWindow, 0)
      : null;
  const remainingPercent =
    effectiveWindow !== null && effectiveWindow > 0 && remainingInEffectiveWindow !== null
      ? Math.round((remainingInEffectiveWindow / effectiveWindow) * 100)
      : null;

  return [
    `**Context Usage**`,
    `- Thread: ${threadId}`,
    `- Model context window: ${contextWindow === null ? "unknown" : contextWindow.toLocaleString()}`,
    `- Context left: ${
      remainingPercent === null ? "unknown" : `${remainingPercent}%`
    }`,
    `- Effective remaining tokens: ${
      remainingInEffectiveWindow === null
        ? "unknown"
        : `${remainingInEffectiveWindow.toLocaleString()} (baseline ${CODEX_CONTEXT_BASELINE_TOKENS.toLocaleString()})`
    }`,
    "",
    `**Last Token Usage**`,
    `- Input: ${formatNumber(last.inputTokens)}`,
    `- Cached input: ${formatNumber(last.cachedInputTokens)}`,
    `- Output: ${formatNumber(last.outputTokens)}`,
    `- Reasoning output: ${formatNumber(last.reasoningOutputTokens)}`,
    `- Total: ${formatNumber(last.totalTokens)}`,
    "",
    `**Total Token Usage**`,
    `- Input: ${formatNumber(total.inputTokens)}`,
    `- Cached input: ${formatNumber(total.cachedInputTokens)}`,
    `- Output: ${formatNumber(total.outputTokens)}`,
    `- Reasoning output: ${formatNumber(total.reasoningOutputTokens)}`,
    `- Total: ${formatNumber(total.totalTokens)}`,
  ].join("\n");
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

export async function handleMessage(
  message: Message,
  context: CommandContext,
  contentOverride?: string,
): Promise<HandleResult> {
  const inputContent = contentOverride ?? message.content;
  if (!inputContent.trim()) {
    return { handled: true, threadId: null, input: null };
  }

  const content = inputContent.trim();
  const channelId = message.channelId;
  const { command, args } = parseThreadArgs(content);

  if (command === "!help") {
    await message.reply([
      "Discord Shepherd commands:",
      "- !help",
      "- !newthread",
      "- !limits",
      "- !context",
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

  if (command === "!limits") {
    const limits = await context.manager.readAccountRateLimits();
    await replyChunked(message, formatRateLimitsForDiscord(limits.rateLimits));
    return { handled: true, threadId: null, input: null };
  }

  if (command === "!context") {
    const threadId = context.getActiveThreadId(channelId);
    if (!threadId) {
      await message.reply("No active thread in this channel yet. Use !newthread first.");
      return { handled: true, threadId: null, input: null };
    }
    const result = await context.manager.readThreadTokenUsage(threadId);
    if (!result.tokenUsage) {
      await message.reply("No context telemetry yet for this thread. Send a turn first.");
      return { handled: true, threadId, input: null };
    }
    await replyChunked(message, formatThreadContextForDiscord(threadId, result.tokenUsage));
    return { handled: true, threadId, input: null };
  }

  if (command === "!newthread") {
    const threadId = await context.createAndBindChannelThread(channelId);
    await message.reply(`Started new thread: ${threadId}`);
    return { handled: true, threadId, input: null };
  }

  if (command === "!thread" && args.length === 0) {
    const existing = context.getActiveThreadId(channelId);
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
    const threadId = context.getActiveThreadId(channelId);
    if (!threadId) {
      await message.reply("No active thread in this channel.");
      return { handled: true, threadId: null, input: null };
    }
    await context.manager.setThreadName(threadId, { name });
    await replyChunked(message, `Thread renamed: ${name}`);
    return { handled: true, threadId, input: null };
  }

  if (command === "!threadread") {
    const threadId = args[0] ?? context.getActiveThreadId(channelId);
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
    const sourceThreadId = args[0] ?? context.getActiveThreadId(channelId);
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
    const target = args[0] ?? context.getActiveThreadId(channelId);
    if (!target) {
      await message.reply("Usage: !archive <id>");
      return { handled: true, threadId: null, input: null };
    }
    await context.manager.archiveThread(target);
    if (context.getActiveThreadId(channelId) === target) {
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
    const target = args[1] ?? context.getActiveThreadId(channelId);
    if (!Number.isInteger(numTurns) || numTurns < 1 || !target) {
      await message.reply("Usage: !rollback <numTurns> [id]");
      return { handled: true, threadId: null, input: null };
    }
    await context.manager.rollbackThread(target, { numTurns });
    await message.reply(`Rolled back ${numTurns} turn(s) on ${target}`);
    return { handled: true, threadId: target, input: null };
  }

  if (command === "!compact") {
    const target = args[0] ?? context.getActiveThreadId(channelId);
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
