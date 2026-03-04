import type { Message } from "discord.js";

import type { ConversationService } from "../../core/conversation_service.js";

type HandleResult = { handled: boolean; threadId: string | null; input: string | null };
const DISCORD_MESSAGE_LIMIT = 1900;
const CODEX_CONTEXT_BASELINE_TOKENS = 12_000;

export type CommandContext = {
  conversation: ConversationService;
  getActiveThreadId: (channelId: string) => string | null;
  getChannelRepo: (channelId: string) => string | null;
  getChannelSkillsCwd: (channelId: string) => Promise<string | null>;
  setChannelRepo: (channelId: string, repoSlug: string) => Promise<{ repoSlug: string }>;
  ensureChannelThread: (channelId: string) => Promise<string>;
  createAndBindChannelThread: (channelId: string) => Promise<string>;
  resumeChannelThread: (channelId: string, threadId: string) => Promise<string>;
  forkChannelThread: (channelId: string, sourceThreadId: string) => Promise<string>;
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

function parseKeyValueArgs(args: string[]): Record<string, string> {
  const entries = args
    .map((arg) => arg.split("=", 2))
    .filter((parts) => parts.length === 2 && parts[0] && parts[1])
    .map(([key, value]) => [key.toLowerCase(), value] as const);
  return Object.fromEntries(entries);
}

function mapRemoteSkillsError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes("hazelnuts") && lower.includes("403")) {
    return "Remote skills are not enabled for this account (Hazelnut access denied).";
  }
  if (lower.includes("notallowed")) {
    return "Remote skills are not enabled for this account.";
  }
  return message;
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
  const result = await context.conversation.listStoredThreads({ archived, limit: 25 });
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

function formatSkillsForDiscord(value: unknown): string {
  const payload = asRecord(value);
  const entries = Array.isArray(payload.data) ? payload.data : [];
  if (entries.length === 0) {
    return "No skills found.";
  }

  const lines: string[] = ["**Skills**"];
  for (const entry of entries) {
    const record = asRecord(entry);
    const cwd = asString(record.cwd) ?? "unknown";
    const skills = Array.isArray(record.skills) ? record.skills : [];
    const errors = Array.isArray(record.errors) ? record.errors : [];
    lines.push(`- cwd: ${cwd} (skills: ${skills.length}, errors: ${errors.length})`);
    for (const skillValue of skills) {
      const skill = asRecord(skillValue);
      const name = asString(skill.name) ?? "unknown";
      const scope = asString(skill.scope) ?? "unknown";
      const enabled = skill.enabled === true ? "enabled" : "disabled";
      const description = asString(skill.description) ?? "";
      lines.push(`  - ${name} [${scope}] ${enabled}${description ? ` :: ${description}` : ""}`);
    }
    for (const errorValue of errors) {
      const error = asRecord(errorValue);
      const message = asString(error.message) ?? "unknown error";
      const path = asString(error.path) ?? "unknown path";
      lines.push(`  - error: ${message} (${path})`);
    }
  }
  return lines.join("\n");
}

function formatRemoteSkillsForDiscord(value: unknown): string {
  const payload = asRecord(value);
  const entries = Array.isArray(payload.data) ? payload.data : [];
  if (entries.length === 0) {
    return "No remote skills found.";
  }
  return [
    `**Remote Skills (${entries.length})**`,
    ...entries.map((entry, index) => {
      const record = asRecord(entry);
      const id = asString(record.id) ?? "unknown";
      const name = asString(record.name) ?? "unknown";
      const description = asString(record.description) ?? "";
      return `${index + 1}. ${name} (${id})${description ? ` :: ${description}` : ""}`;
    }),
  ].join("\n");
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
      "- !repo",
      "- !repo <owner>/<repo>",
      "- !limits",
      "- !context",
      "- !skills [reload]",
      "- !skills remote [enabled=true|false] [scope=example|workspace-shared|all-shared|personal] [surface=chatgpt|codex|api|atlas]",
      "- !skill export <hazelnutId>",
      "- !skill enable <path>",
      "- !skill disable <path>",
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
      "- !interrupt",
      "Any other message is sent as a Shepherd turn.",
    ].join("\n"));
    return { handled: true, threadId: null, input: null };
  }

  if (command === "!threads") {
    const mode = (args[0] ?? "").toLowerCase();
    if (mode === "loaded") {
      const loaded = await context.conversation.listLoadedThreads({ limit: 100 });
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
    const limits = await context.conversation.readAccountRateLimits();
    await replyChunked(message, formatRateLimitsForDiscord(limits.rateLimits));
    return { handled: true, threadId: null, input: null };
  }

  if (command === "!context") {
    const threadId = context.getActiveThreadId(channelId);
    if (!threadId) {
      await message.reply("No active thread in this channel yet. Use !newthread first.");
      return { handled: true, threadId: null, input: null };
    }
    const result = await context.conversation.readThreadTokenUsage(threadId);
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

  if (command === "!repo") {
    const repoSlug = args[0]?.trim();
    if (!repoSlug) {
      const current = context.getChannelRepo(channelId);
      await message.reply(
        current
          ? `Current repo for this channel: ${current}`
          : "No repo selected for this channel. Use `!repo <owner>/<repo>`, `!repo ~`, or `!repo ~/path`.",
      );
      return { handled: true, threadId: null, input: null };
    }
    const configured = await context.setChannelRepo(channelId, repoSlug);
    const activeThreadId = context.getActiveThreadId(channelId);
    await message.reply(
      activeThreadId
        ? `Repo set for this channel: ${configured.repoSlug}\nNote: active thread ${activeThreadId} keeps its current session/cwd; this repo applies to future !newthread/!fork/unloaded !thread resumes.`
        : `Repo set for this channel: ${configured.repoSlug}`,
    );
    return { handled: true, threadId: null, input: null };
  }

  if (command === "!skills") {
    const skillsCwd = await context.getChannelSkillsCwd(channelId);
    if (!skillsCwd) {
      await message.reply("No repo selected for this channel. Use `!repo <owner>/<repo>`, `!repo ~`, or `!repo ~/path` first.");
      return { handled: true, threadId: null, input: null };
    }

    const mode = (args[0] ?? "").toLowerCase();
    if (mode === "remote") {
      const kv = parseKeyValueArgs(args.slice(1));
      const enabled = kv.enabled === "true" ? true : kv.enabled === "false" ? false : undefined;
      const hazelnutScope = kv.scope;
      const productSurface = kv.surface;
      try {
        const remote = await context.conversation.listRemoteSkills({
          enabled,
          hazelnutScope: hazelnutScope as
            | "example"
            | "workspace-shared"
            | "all-shared"
            | "personal"
            | undefined,
          productSurface: productSurface as "chatgpt" | "codex" | "api" | "atlas" | undefined,
        });
        await replyChunked(message, formatRemoteSkillsForDiscord(remote));
      } catch (error) {
        await message.reply(mapRemoteSkillsError(error));
      }
      return { handled: true, threadId: null, input: null };
    }

    const forceReload = mode === "reload";
    const listed = await context.conversation.listSkills({ cwds: [skillsCwd], forceReload });
    await replyChunked(message, formatSkillsForDiscord(listed));
    return { handled: true, threadId: null, input: null };
  }

  if (command === "!skill") {
    const skillsCwd = await context.getChannelSkillsCwd(channelId);
    if (!skillsCwd) {
      await message.reply("No repo selected for this channel. Use `!repo <owner>/<repo>`, `!repo ~`, or `!repo ~/path` first.");
      return { handled: true, threadId: null, input: null };
    }

    const sub = (args[0] ?? "").toLowerCase();
    if (sub === "export") {
      const hazelnutId = args[1]?.trim();
      if (!hazelnutId) {
        await message.reply("Usage: !skill export <hazelnutId>");
        return { handled: true, threadId: null, input: null };
      }
      try {
        const exported = await context.conversation.exportRemoteSkill({ hazelnutId });
        await message.reply(`Exported remote skill ${exported.id} -> ${exported.path}`);
      } catch (error) {
        await message.reply(mapRemoteSkillsError(error));
      }
      return { handled: true, threadId: null, input: null };
    }

    if (sub === "enable" || sub === "disable") {
      const path = args.slice(1).join(" ").trim();
      if (!path) {
        await message.reply(`Usage: !skill ${sub} <path>`);
        return { handled: true, threadId: null, input: null };
      }
      const enabled = sub === "enable";
      const result = await context.conversation.writeSkillConfig({ path, enabled });
      await message.reply(
        `${enabled ? "Enabled" : "Disabled"} skill at ${path} (effectiveEnabled=${result.effectiveEnabled})`,
      );
      return { handled: true, threadId: null, input: null };
    }
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
      context.conversation.getThreadState(requestedThreadId);
    } catch {
      resolvedThreadId = await context.resumeChannelThread(channelId, requestedThreadId);
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
    await context.conversation.setThreadName(threadId, { name });
    await replyChunked(message, `Thread renamed: ${name}`);
    return { handled: true, threadId, input: null };
  }

  if (command === "!threadread") {
    const threadId = args[0] ?? context.getActiveThreadId(channelId);
    if (!threadId) {
      await message.reply("Usage: !threadread <id>");
      return { handled: true, threadId: null, input: null };
    }
    const result = await context.conversation.readThread(threadId, { includeTurns: false });
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
    const forkedThreadId = await context.forkChannelThread(channelId, sourceThreadId);
    await message.reply(`Forked thread ${sourceThreadId} -> ${forkedThreadId}`);
    return { handled: true, threadId: forkedThreadId, input: null };
  }

  if (command === "!archive") {
    const target = args[0] ?? context.getActiveThreadId(channelId);
    if (!target) {
      await message.reply("Usage: !archive <id>");
      return { handled: true, threadId: null, input: null };
    }
    await context.conversation.archiveThread(target);
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
    await context.conversation.unarchiveThread(target);
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
    await context.conversation.rollbackThread(target, { numTurns });
    await message.reply(`Rolled back ${numTurns} turn(s) on ${target}`);
    return { handled: true, threadId: target, input: null };
  }

  if (command === "!compact") {
    const target = args[0] ?? context.getActiveThreadId(channelId);
    if (!target) {
      await message.reply("Usage: !compact <id>");
      return { handled: true, threadId: null, input: null };
    }
    await context.conversation.compactThread(target);
    await message.reply(`Started compaction for thread: ${target}`);
    return { handled: true, threadId: target, input: null };
  }

  if (command === "!interrupt") {
    if (args.length > 0) {
      await message.reply("Usage: !interrupt");
      return { handled: true, threadId: null, input: null };
    }
    const target = context.getActiveThreadId(channelId);
    if (!target) {
      await message.reply("No active thread in this channel.");
      return { handled: true, threadId: null, input: null };
    }
    await context.conversation.interruptTurn(target);
    await message.reply(`Interrupt requested for thread: ${target}`);
    return { handled: true, threadId: target, input: null };
  }

  const threadId = await context.ensureChannelThread(channelId);
  return { handled: false, threadId, input: content };
}
