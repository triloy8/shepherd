import type { Message } from "discord.js";

import { executeControlAction } from "../../core/control_actions_service.js";
import type { ConversationService } from "../../core/conversation_service.js";
import type { ListModelsResponse, ModelSummary, ThreadModelState } from "../../../shared/protocol/requests.js";

type HandleResult = { handled: boolean; threadId: string | null; input: string | null };
const DISCORD_MESSAGE_LIMIT = 1900;
const CODEX_CONTEXT_BASELINE_TOKENS = 12_000;

export type CommandContext = {
  conversation: ConversationService;
  getActiveThreadId: (channelId: string) => string | null;
  getChannelRepo: (channelId: string) => string | null;
  setChannelRepo: (channelId: string, repoSlug: string) => Promise<{ repoSlug: string }>;
  ensureChannelThread: (channelId: string) => Promise<string>;
  createAndBindChannelThread: (channelId: string) => Promise<string>;
  resumeChannelThread: (channelId: string, threadId: string) => Promise<string>;
  forkChannelThread: (channelId: string, sourceThreadId: string) => Promise<string>;
  bindChannelToThread: (channelId: string, threadId: string) => Promise<void>;
  switchChannelThread: (channelId: string, threadId: string) => Promise<string>;
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

function formatThreadModelForDiscord(modelState: ThreadModelState): string {
  const lines = [
    "**Model**",
    `- Thread: ${modelState.threadId}`,
    `- Current: ${modelState.currentModel ?? "unknown"}`,
    `- Provider: ${modelState.modelProvider ?? "unknown"}`,
  ];
  if (modelState.pendingModel) {
    lines.push(`- Pending next turn: ${modelState.pendingModel}`);
  }
  return lines.join("\n");
}

function formatModelEntry(
  model: ModelSummary,
  index: number,
  modelState: ThreadModelState | null,
  defaultModel: string | null,
): string {
  const flags: string[] = [];
  if (model.model === modelState?.currentModel) flags.push("current");
  if (model.model === modelState?.pendingModel) flags.push("pending");
  if (model.model === defaultModel || model.isDefault) flags.push("default");
  const description = model.description ? ` - ${model.description}` : "";
  const suffix = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
  return `${index + 1}. \`${model.model}\`${suffix}${description}`;
}

function formatModelsForDiscord(result: ListModelsResponse, modelState: ThreadModelState | null): string {
  if (result.data.length === 0) {
    return "No models returned by Codex app-server.";
  }

  const defaultEntry = result.data.find((entry) => entry.isDefault) ?? null;
  const lines = ["**Models**"];

  if (modelState) {
    lines.push(`- Thread: ${modelState.threadId}`);
    lines.push(`- Current: ${modelState.currentModel ?? "unknown"}`);
    if (modelState.pendingModel) {
      lines.push(`- Pending next turn: ${modelState.pendingModel}`);
    }
  }
  if (defaultEntry) {
    lines.push(`- App default: ${defaultEntry.model}`);
  }
  lines.push("");

  const defaultModel = defaultEntry?.model ?? null;
  const visibleEntries = result.data.slice(0, 20);
  for (const [index, entry] of visibleEntries.entries()) {
    lines.push(formatModelEntry(entry, index, modelState, defaultModel));
  }

  if (result.nextCursor) {
    lines.push("", "More models are available but not shown.");
  }

  return lines.join("\n");
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
      "- !models",
      "- !model",
      "- !model set <id>",
      "- !context",
      "- !skills [reload]",
      "- !skills remote [enabled=true|false] [scope=example|workspace-shared|all-shared|personal] [surface=chatgpt|codex|api|atlas]",
      "- !skill export <hazelnutId>",
      "- !skill enable <name-or-path>",
      "- !skill disable <name-or-path>",
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
    const result = await executeControlAction(context, { type: "limits.read" });
    if (result.type !== "limits.read") {
      throw new Error("Unexpected control action result for limits.read.");
    }
    await replyChunked(message, formatRateLimitsForDiscord(result.rateLimits));
    return { handled: true, threadId: null, input: null };
  }

  if (command === "!models") {
    const result = await executeControlAction(context, { type: "models.list", channelId });
    if (result.type !== "models.list") {
      throw new Error("Unexpected control action result for models.list.");
    }
    await replyChunked(message, formatModelsForDiscord(result.models, result.modelState));
    return { handled: true, threadId: result.modelState?.threadId ?? null, input: null };
  }

  if (command === "!model") {
    const subcommand = (args[0] ?? "").toLowerCase();
    const threadId = context.getActiveThreadId(channelId);
    if (!threadId) {
      await message.reply("No active thread in this channel yet. Use !newthread first.");
      return { handled: true, threadId: null, input: null };
    }

    if (!subcommand) {
      await replyChunked(message, formatThreadModelForDiscord(context.conversation.getThreadModel(threadId)));
      return { handled: true, threadId, input: null };
    }

    if (subcommand !== "set") {
      await message.reply("Usage: !model\nUsage: !model set <id>");
      return { handled: true, threadId, input: null };
    }

    const requestedModel = args.slice(1).join(" ").trim();
    if (!requestedModel) {
      await message.reply("Usage: !model set <id>");
      return { handled: true, threadId, input: null };
    }

    const result = await executeControlAction(context, {
      type: "model.set",
      channelId,
      requestedModel,
    });
    if (result.type !== "model.set") {
      throw new Error("Unexpected control action result for model.set.");
    }
    if (!result.ok) {
      await message.reply(result.message);
      return { handled: true, threadId, input: null };
    }

    await message.reply(
      `Model for thread ${result.threadId} set to \`${result.model}\`.\nApplies to the next new turn and subsequent turns.`,
    );
    return { handled: true, threadId: result.threadId, input: null };
  }

  if (command === "!context") {
    const result = await executeControlAction(context, { type: "context.read", channelId });
    if (result.type !== "context.read") {
      throw new Error("Unexpected control action result for context.read.");
    }
    if (!result.ok) {
      await message.reply(result.message);
      return { handled: true, threadId: null, input: null };
    }
    if (!result.tokenUsage) {
      await message.reply("No context telemetry yet for this thread. Send a turn first.");
      return { handled: true, threadId: result.threadId, input: null };
    }
    await replyChunked(message, formatThreadContextForDiscord(result.threadId, result.tokenUsage));
    return { handled: true, threadId: result.threadId, input: null };
  }

  if (command === "!newthread") {
    const threadId = await context.createAndBindChannelThread(channelId);
    await message.reply(`Started new thread: ${threadId}`);
    return { handled: true, threadId, input: null };
  }

  if (command === "!repo") {
    const repoSlug = args[0]?.trim();
    if (!repoSlug) {
      const result = await executeControlAction(context, { type: "repo.get", channelId });
      if (result.type !== "repo.get") {
        throw new Error("Unexpected control action result for repo.get.");
      }
      const current = result.currentRepo;
      await message.reply(
        current
          ? `Current repo for this channel: ${current}`
          : "No repo selected for this channel. Use `!repo <owner>/<repo>`, `!repo ~`, or `!repo ~/path`.",
      );
      return { handled: true, threadId: null, input: null };
    }
    const configured = await executeControlAction(context, {
      type: "repo.set",
      channelId,
      repoInput: repoSlug,
    });
    if (configured.type !== "repo.set") {
      throw new Error("Unexpected control action result for repo.set.");
    }
    await message.reply(
      configured.activeThreadId
        ? `Repo set for this channel: ${configured.repoSlug}\nNote: active thread ${configured.activeThreadId} keeps its current session/cwd; this repo applies to future !newthread/!fork.`
        : `Repo set for this channel: ${configured.repoSlug}`,
    );
    return { handled: true, threadId: null, input: null };
  }

  if (command === "!skills") {
    const activeThreadId = context.getActiveThreadId(channelId);
    if (!activeThreadId) {
      await message.reply("No active thread in this channel. Use !newthread or !thread <id> first.");
      return { handled: true, threadId: null, input: null };
    }

    const mode = (args[0] ?? "").toLowerCase();
    if (mode === "remote") {
      const kv = parseKeyValueArgs(args.slice(1));
      const result = await executeControlAction(context, {
        type: "skills.list-remote",
        channelId,
        enabled: kv.enabled === "true" ? true : kv.enabled === "false" ? false : undefined,
        hazelnutScope: kv.scope as "example" | "workspace-shared" | "all-shared" | "personal" | undefined,
        productSurface: kv.surface as "chatgpt" | "codex" | "api" | "atlas" | undefined,
      });
      if (result.type !== "skills.list-remote") {
        throw new Error("Unexpected control action result for skills.list-remote.");
      }
      if (!result.ok) {
        await message.reply(mapRemoteSkillsError(result.message));
        return { handled: true, threadId: null, input: null };
      }
      await replyChunked(message, formatRemoteSkillsForDiscord(result.remote));
      return { handled: true, threadId: null, input: null };
    }

    const forceReload = mode === "reload";
    const listed = await context.conversation.listSkills(activeThreadId, { forceReload });
    await replyChunked(message, formatSkillsForDiscord(listed));
    return { handled: true, threadId: null, input: null };
  }

  if (command === "!skill") {
    const activeThreadId = context.getActiveThreadId(channelId);
    if (!activeThreadId) {
      await message.reply("No active thread in this channel. Use !newthread or !thread <id> first.");
      return { handled: true, threadId: null, input: null };
    }

    const sub = (args[0] ?? "").toLowerCase();
    if (sub === "export") {
      const hazelnutId = args[1]?.trim();
      if (!hazelnutId) {
        await message.reply("Usage: !skill export <hazelnutId>");
        return { handled: true, threadId: null, input: null };
      }
      const result = await executeControlAction(context, {
        type: "skill.export-remote",
        channelId,
        hazelnutId,
      });
      if (result.type !== "skill.export-remote") {
        throw new Error("Unexpected control action result for skill.export-remote.");
      }
      if (!result.ok) {
        await message.reply(mapRemoteSkillsError(result.message));
        return { handled: true, threadId: null, input: null };
      }
      await message.reply(`Exported remote skill ${result.exported.id} -> ${result.exported.path}`);
      return { handled: true, threadId: null, input: null };
    }

    if (sub === "enable" || sub === "disable") {
      const requestedSkill = args.slice(1).join(" ").trim();
      if (!requestedSkill) {
        await message.reply(`Usage: !skill ${sub} <name-or-path>`);
        return { handled: true, threadId: null, input: null };
      }
      const result = await executeControlAction(context, {
        type: "skill.set-enabled",
        channelId,
        requestedSkill,
        enabled: sub === "enable",
      });
      if (result.type !== "skill.set-enabled") {
        throw new Error("Unexpected control action result for skill.set-enabled.");
      }
      if (!result.ok) {
        await message.reply(result.message);
        return { handled: true, threadId: null, input: null };
      }
      await message.reply(
        `${result.enabled ? "Enabled" : "Disabled"} skill ${result.requestedSkill} (effectiveEnabled=${result.effectiveEnabled})`,
      );
      return { handled: true, threadId: null, input: null };
    }
  }

  if (command === "!thread" && args.length === 0) {
    const result = await executeControlAction(context, {
      type: "thread.get-current",
      channelId,
    });
    if (result.type !== "thread.get-current") {
      throw new Error("Unexpected control action result for thread.get-current.");
    }
    const existing = result.threadId;
    await message.reply(existing ? `Current thread: ${existing}` : "No thread yet. Send a message to start one.");
    return { handled: true, threadId: existing, input: null };
  }

  if (command === "!thread" && args.length > 0) {
    const requestedThreadId = args[0]?.trim();
    if (!requestedThreadId) {
      await message.reply("Usage: !thread <id>");
      return { handled: true, threadId: null, input: null };
    }

    const resolvedThreadId = await context.switchChannelThread(channelId, requestedThreadId);
    await message.reply(`Switched active thread to: ${resolvedThreadId}`);
    return { handled: true, threadId: resolvedThreadId, input: null };
  }

  if (command === "!threadname") {
    const name = args.join(" ").trim();
    if (!name) {
      await message.reply("Usage: !threadname <name>");
      return { handled: true, threadId: null, input: null };
    }
    const result = await executeControlAction(context, {
      type: "thread.rename",
      channelId,
      name,
    });
    if (result.type !== "thread.rename") {
      throw new Error("Unexpected control action result for thread.rename.");
    }
    if (!result.ok) {
      await message.reply(result.message);
      return { handled: true, threadId: null, input: null };
    }
    await replyChunked(message, `Thread renamed: ${result.name}`);
    return { handled: true, threadId: result.threadId, input: null };
  }

  if (command === "!threadread") {
    const result = await executeControlAction(context, {
      type: "thread.read",
      channelId,
      threadId: args[0],
    });
    if (result.type !== "thread.read") {
      throw new Error("Unexpected control action result for thread.read.");
    }
    if (!result.ok) {
      await message.reply(result.message);
      return { handled: true, threadId: null, input: null };
    }
    const threadId = result.threadId;
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
    const result = await executeControlAction(context, {
      type: "thread.archive",
      channelId,
      threadId: args[0],
    });
    if (result.type !== "thread.archive") {
      throw new Error("Unexpected control action result for thread.archive.");
    }
    if (!result.ok) {
      await message.reply(result.message);
      return { handled: true, threadId: null, input: null };
    }
    await message.reply(`Archived thread: ${result.threadId}`);
    return { handled: true, threadId: result.threadId, input: null };
  }

  if (command === "!unarchive") {
    const target = args[0];
    if (!target) {
      await message.reply("Usage: !unarchive <id>");
      return { handled: true, threadId: null, input: null };
    }
    const result = await executeControlAction(context, {
      type: "thread.unarchive",
      threadId: target,
    });
    if (result.type !== "thread.unarchive") {
      throw new Error("Unexpected control action result for thread.unarchive.");
    }
    await message.reply(`Unarchived thread: ${result.threadId}`);
    return { handled: true, threadId: result.threadId, input: null };
  }

  if (command === "!rollback") {
    const result = await executeControlAction(context, {
      type: "thread.rollback",
      channelId,
      numTurns: Number(args[0]),
      threadId: args[1],
    });
    if (result.type !== "thread.rollback") {
      throw new Error("Unexpected control action result for thread.rollback.");
    }
    if (!result.ok) {
      await message.reply(result.message);
      return { handled: true, threadId: null, input: null };
    }
    await message.reply(`Rolled back ${result.numTurns} turn(s) on ${result.threadId}`);
    return { handled: true, threadId: result.threadId, input: null };
  }

  if (command === "!compact") {
    const result = await executeControlAction(context, {
      type: "thread.compact",
      channelId,
      threadId: args[0],
    });
    if (result.type !== "thread.compact") {
      throw new Error("Unexpected control action result for thread.compact.");
    }
    if (!result.ok) {
      await message.reply(result.message);
      return { handled: true, threadId: null, input: null };
    }
    await message.reply(`Started compaction for thread: ${result.threadId}`);
    return { handled: true, threadId: result.threadId, input: null };
  }

  if (command === "!interrupt") {
    if (args.length > 0) {
      await message.reply("Usage: !interrupt");
      return { handled: true, threadId: null, input: null };
    }
    const result = await executeControlAction(context, {
      type: "turn.interrupt",
      channelId,
    });
    if (result.type !== "turn.interrupt") {
      throw new Error("Unexpected control action result for turn.interrupt.");
    }
    if (!result.ok) {
      await message.reply(result.message);
      return { handled: true, threadId: null, input: null };
    }
    await message.reply(`Interrupt requested for thread: ${result.threadId}`);
    return { handled: true, threadId: result.threadId, input: null };
  }

  if (command.startsWith("!")) {
    await message.reply(`Unknown command: \`${command}\`. Use \`!help\` to inspect available commands.`);
    return { handled: true, threadId: null, input: null };
  }

  const threadId = await context.ensureChannelThread(channelId);
  return { handled: false, threadId, input: content };
}
