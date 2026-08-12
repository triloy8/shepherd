import type { APIEmbed, APIEmbedField, Message } from "discord.js";

import { executeControlAction } from "../../core/control_actions_service.js";
import type { ConversationService } from "../../core/conversation_service.js";
import type {
  RuntimeLifecycleOrchestrator,
  RuntimeLifecycleResult,
} from "../../core/runtime_lifecycle_orchestrator.js";
import type { RuntimeActivity } from "../../core/session_manager.js";
import type { SurfaceListeningMode } from "../../core/surface_state_service.js";
import type { ListModelsResponse, ModelSummary, ThreadModelState } from "../../../shared/protocol/requests.js";
import type { UserInput } from "../../../shared/protocol/user_input.js";
import { toTextUserInput } from "../../../shared/protocol/user_input.js";
import {
  buildDescriptionPages,
  buildEmbed,
  isEmbedRejection,
  type EmbedTone,
} from "./embed_renderer.js";

type HandleResult = { handled: boolean; threadId: string | null; input: UserInput[] | null };
const DISCORD_MESSAGE_LIMIT = 1900;
const CODEX_CONTEXT_BASELINE_TOKENS = 12_000;

export type CommandContext = {
  conversation: ConversationService;
  getSurfaceThreadId: (surfaceId: string) => string | null;
  getSurfaceProject: (surfaceId: string) => string | null;
  getSurfaceListeningMode: (surfaceId: string) => SurfaceListeningMode;
  setSurfaceListeningMode: (
    surfaceId: string,
    mode: Exclude<SurfaceListeningMode, "paused">,
  ) => SurfaceListeningMode;
  pauseSurfaceListening: (surfaceId: string) => SurfaceListeningMode;
  resumeSurfaceListening: (surfaceId: string) => SurfaceListeningMode;
  setSurfaceProject: (surfaceId: string, repoSlug: string) => Promise<{ repoSlug: string }>;
  ensureSurfaceThread: (surfaceId: string) => Promise<string>;
  createSurfaceThread: (surfaceId: string) => Promise<string>;
  switchSurfaceThread: (surfaceId: string, threadId: string) => Promise<string>;
  forkSurfaceThread: (surfaceId: string, sourceThreadId: string) => Promise<string>;
  clearSurfaceThread: (surfaceId: string) => void;
  runtimeLifecycle?: Pick<RuntimeLifecycleOrchestrator, "restart" | "deploy">;
};

function formatTimestamp(seconds: number | null): string {
  if (!seconds) return "unknown";
  return new Date(seconds * 1000).toISOString();
}

function parseThreadArgs(content: string): { command: string; args: string[] } {
  const [command, ...rest] = content.split(/\s+/);
  return { command: command.toLowerCase(), args: rest };
}

function displayListeningMode(mode: SurfaceListeningMode): string {
  if (mode === "open") return "Open";
  if (mode === "paused") return "Paused";
  return "Mention-only";
}

function effectiveListeningMode(message: Message, context: CommandContext): SurfaceListeningMode {
  const configured = context.getSurfaceListeningMode(message.channelId);
  if (message.guildId === null && configured !== "paused") return "open";
  return configured;
}

function formatListeningStatus(message: Message, context: CommandContext): string {
  const mode = effectiveListeningMode(message, context);
  const detail =
    mode === "open"
      ? "All human text and image messages are accepted."
      : mode === "paused"
        ? "Conversation input is ignored; control commands remain available."
        : "Only commands and messages that mention Shepherd are accepted.";
  return `Listening: **${displayListeningMode(mode)}**\n${detail}`;
}

function listeningStatusEmbed(message: Message, context: CommandContext): APIEmbed {
  const mode = effectiveListeningMode(message, context);
  const detail =
    mode === "open"
      ? "All human text and image messages are accepted."
      : mode === "paused"
        ? "Conversation input is ignored; control commands remain available."
        : "Only commands and messages that mention Shepherd are accepted.";
  return buildEmbed({
    title: "Listening",
    tone: mode === "paused" ? "warning" : "info",
    fields: [{ name: "Mode", value: displayListeningMode(mode), inline: true }],
    description: detail,
  });
}

function formatSurfaceStatus(message: Message, context: CommandContext): string {
  const channelId = message.channelId;
  const threadId = context.getSurfaceThreadId(channelId);
  const project = context.getSurfaceProject(channelId);
  const lines = [
    "**Shepherd channel**",
    `- Listening: ${displayListeningMode(effectiveListeningMode(message, context))}`,
    `- Repository: ${project ?? "not selected"}`,
    `- Thread: ${threadId ?? "not attached"}`,
  ];

  if (threadId) {
    const thread = context.conversation.getThreadState(threadId);
    const model = context.conversation.getThreadModel(threadId);
    lines.push(`- Turn: ${thread.activeTurnId ? `running (${thread.activeTurnId})` : "idle"}`);
    lines.push(`- Model: ${model.pendingModel ?? model.currentModel ?? "default"}`);
  }

  return lines.join("\n");
}

function surfaceStatusEmbed(message: Message, context: CommandContext): APIEmbed {
  const channelId = message.channelId;
  const threadId = context.getSurfaceThreadId(channelId);
  const fields: APIEmbedField[] = [
    {
      name: "Listening",
      value: displayListeningMode(effectiveListeningMode(message, context)),
      inline: true,
    },
    { name: "Repository", value: context.getSurfaceProject(channelId) ?? "Not selected", inline: true },
    { name: "Thread", value: threadId ? `\`${threadId}\`` : "Not attached" },
  ];
  if (threadId) {
    const thread = context.conversation.getThreadState(threadId);
    const model = context.conversation.getThreadModel(threadId);
    fields.push(
      {
        name: "Turn",
        value: thread.activeTurnId ? `Running (\`${thread.activeTurnId}\`)` : "Idle",
        inline: true,
      },
      { name: "Model", value: `\`${model.pendingModel ?? model.currentModel ?? "default"}\``, inline: true },
    );
  }
  return buildEmbed({ title: "Shepherd channel", fields, tone: "info" });
}

function formatRecoveryInstructions(context: CommandContext, channelId: string): string {
  const project = context.getSurfaceProject(channelId);
  const threadId = context.getSurfaceThreadId(channelId);
  const listeningMode = context.getSurfaceListeningMode(channelId);
  const commands = [
    ...(project ? [`!repo ${project}`] : []),
    ...(threadId ? [`!thread ${threadId}`] : []),
    ...(listeningMode === "open" ? ["!listen open"] : []),
  ];

  if (commands.length === 0) {
    return "No channel binding needs to be restored after reconnect.";
  }

  return `To continue after reconnect:\n\`\`\`\n${commands.join("\n")}\n\`\`\``;
}

function formatRuntimeActivity(activity: RuntimeActivity): string {
  const lines = [
    ...(activity.activeTurnThreadIds.length > 0
      ? [`Active turns: ${activity.activeTurnThreadIds.join(", ")}`]
      : []),
    ...(activity.pendingApprovalIds.length > 0
      ? [`Pending approvals: ${activity.pendingApprovalIds.join(", ")}`]
      : []),
  ];
  return lines.join("\n");
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

function formatWindowField(label: string, value: unknown): APIEmbedField {
  const data = asRecord(value);
  const used = asNumber(data.usedPercent);
  const duration = asNumber(data.windowDurationMins);
  return {
    name: label,
    value: [
      `Used: **${used === null ? "unknown" : `${used}%`}**`,
      `Window: ${duration === null ? "unknown" : `${duration} min`}`,
      `Resets: ${formatResetTimestamp(data.resetsAt)}`,
    ].join("\n"),
    inline: true,
  };
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

function rateLimitsEmbed(value: unknown): APIEmbed {
  const limits = asRecord(value);
  const credits = asRecord(limits.credits);
  const fields: APIEmbedField[] = [
    { name: "Plan", value: asString(limits.planType) ?? "unknown", inline: true },
    { name: "Limit ID", value: asString(limits.limitId) ?? "unknown", inline: true },
  ];
  if (limits.primary) fields.push(formatWindowField("Primary window", limits.primary));
  if (limits.secondary) fields.push(formatWindowField("Secondary window", limits.secondary));
  fields.push({
    name: "Credits",
    value: [
      `Available: ${credits.hasCredits === true ? "yes" : "no"}`,
      `Unlimited: ${credits.unlimited === true ? "yes" : "no"}`,
      `Balance: ${asString(credits.balance) ?? "unknown"}`,
    ].join("\n"),
  });
  if (!limits.primary && !limits.secondary) {
    const raw = Array.from(safeJson(value));
    const bounded = raw.length > 950 ? `${raw.slice(0, 949).join("")}…` : raw.join("");
    fields.push({ name: "Raw payload", value: `\`\`\`json\n${bounded}\n\`\`\`` });
  }
  return buildEmbed({ title: "Rate limits", fields });
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

function threadContextEmbed(threadId: string, tokenUsage: unknown): APIEmbed {
  const usage = asRecord(tokenUsage);
  const last = asRecord(usage.last);
  const total = asRecord(usage.total);
  const contextWindow = asNumber(usage.modelContextWindow);
  const lastTotalTokens = asNumber(last.totalTokens);
  const effectiveWindow = contextWindow === null ? null : Math.max(contextWindow - CODEX_CONTEXT_BASELINE_TOKENS, 0);
  const used = effectiveWindow === null || lastTotalTokens === null
    ? null
    : Math.max(lastTotalTokens - CODEX_CONTEXT_BASELINE_TOKENS, 0);
  const remaining = effectiveWindow === null || used === null ? null : Math.max(effectiveWindow - used, 0);
  const percent =
    effectiveWindow !== null && effectiveWindow > 0 && remaining !== null
      ? Math.round((remaining / effectiveWindow) * 100)
      : null;
  const usageField = (label: string, data: Record<string, unknown>): APIEmbedField => ({
    name: label,
    value: [
      `Input: ${formatNumber(data.inputTokens)}`,
      `Cached: ${formatNumber(data.cachedInputTokens)}`,
      `Output: ${formatNumber(data.outputTokens)}`,
      `Reasoning: ${formatNumber(data.reasoningOutputTokens)}`,
      `Total: **${formatNumber(data.totalTokens)}**`,
    ].join("\n"),
    inline: true,
  });
  return buildEmbed({
    title: "Context usage",
    description: percent === null ? "Remaining context is unknown." : `**${percent}% context remaining**`,
    fields: [
      { name: "Thread", value: `\`${threadId}\`` },
      {
        name: "Effective remaining",
        value: remaining === null
          ? "unknown"
          : `${remaining.toLocaleString()} tokens\nBaseline: ${CODEX_CONTEXT_BASELINE_TOKENS.toLocaleString()}`,
        inline: true,
      },
      {
        name: "Model window",
        value: contextWindow === null ? "unknown" : `${contextWindow.toLocaleString()} tokens`,
        inline: true,
      },
      usageField("Last turn", last),
      usageField("Thread total", total),
    ],
  });
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

function threadModelEmbed(modelState: ThreadModelState): APIEmbed {
  return buildEmbed({
    title: "Model",
    fields: [
      { name: "Current", value: `\`${modelState.currentModel ?? "unknown"}\``, inline: true },
      { name: "Provider", value: modelState.modelProvider ?? "unknown", inline: true },
      ...(modelState.pendingModel
        ? [{ name: "Pending next turn", value: `\`${modelState.pendingModel}\`` }]
        : []),
      { name: "Thread", value: `\`${modelState.threadId}\`` },
    ],
  });
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

function modelEmbeds(result: ListModelsResponse, modelState: ThreadModelState | null): APIEmbed[] {
  if (result.data.length === 0) {
    return [buildEmbed({ title: "Models", description: "No models returned by Codex app-server.", tone: "neutral" })];
  }
  const defaultEntry = result.data.find((entry) => entry.isDefault) ?? null;
  const defaultModel = defaultEntry?.model ?? null;
  const text = result.data
    .slice(0, 20)
    .map((entry, index) => formatModelEntry(entry, index, modelState, defaultModel))
    .join("\n");
  const fields: APIEmbedField[] = [];
  if (modelState) {
    fields.push(
      { name: "Current", value: `\`${modelState.currentModel ?? "unknown"}\``, inline: true },
      { name: "Pending", value: modelState.pendingModel ? `\`${modelState.pendingModel}\`` : "None", inline: true },
      { name: "Thread", value: `\`${modelState.threadId}\`` },
    );
  }
  if (defaultEntry) fields.push({ name: "App default", value: `\`${defaultEntry.model}\`` });
  return buildDescriptionPages({
    title: "Models",
    text,
    fields,
    footer: result.nextCursor ? "More models are available but not shown" : undefined,
  });
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
): channel is { send: (content: string | { embeds: APIEmbed[] }) => Promise<unknown> } {
  if (!channel || typeof channel !== "object") return false;
  const record = channel as Record<string, unknown>;
  return typeof record.send === "function";
}

async function replyEmbed(
  message: Message,
  embed: APIEmbed,
  fallbackText: string,
): Promise<{ message: unknown; usedFallback: boolean }> {
  try {
    const sent = await message.reply({
      embeds: [embed],
      allowedMentions: { repliedUser: false, parse: [] },
    });
    return { message: sent, usedFallback: false };
  } catch (error) {
    if (!isEmbedRejection(error)) throw error;
    return { message: await message.reply(fallbackText), usedFallback: true };
  }
}

type EditableReply = {
  edit: (payload: string | { content: null; embeds: APIEmbed[] }) => Promise<unknown>;
};

function isEditableReply(value: unknown): value is EditableReply {
  return !!value && typeof value === "object" && typeof (value as { edit?: unknown }).edit === "function";
}

class RuntimeEmbedReporter {
  private current: EditableReply | null = null;
  private currentUsesFallback = false;

  constructor(private readonly message: Message) {}

  async show(options: {
    title: string;
    text: string;
    tone: EmbedTone;
    fields?: APIEmbedField[];
  }): Promise<void> {
    const embed = buildEmbed({
      title: options.title,
      description: options.text,
      tone: options.tone,
      fields: options.fields,
    });
    if (this.current) {
      try {
        await this.current.edit(
          this.currentUsesFallback
            ? `${options.title}\n\n${options.text}`
            : { content: null, embeds: [embed] },
        );
        return;
      } catch {
        this.current = null;
      }
    }
    const result = await replyEmbed(this.message, embed, `${options.title}\n\n${options.text}`);
    if (isEditableReply(result.message)) this.current = result.message;
    this.currentUsesFallback = result.usedFallback;
  }
}

async function replyEmbedPages(
  message: Message,
  embeds: APIEmbed[],
  fallbackText: string,
): Promise<void> {
  if (embeds.length === 0) return;
  try {
    await message.reply({ embeds: [embeds[0]!], allowedMentions: { repliedUser: false, parse: [] } });
    if (!isSendableChannel(message.channel)) return;
    for (const embed of embeds.slice(1)) {
      await message.channel.send({ embeds: [embed] });
    }
  } catch (error) {
    if (!isEmbedRejection(error)) throw error;
    await replyChunked(message, fallbackText);
  }
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

async function replyRuntimeLifecycleResult(
  reporter: RuntimeEmbedReporter,
  result: RuntimeLifecycleResult,
): Promise<void> {
  if (result.type === "restart-requested") {
    return;
  }

  if (result.type === "deployment-in-progress") {
    await reporter.show({
      title: "Deployment in progress",
      tone: "warning",
      text: result.action === "restart"
        ? "Restart is unavailable until the deployment finishes."
        : "A deployment is already in progress.",
    });
    return;
  }

  if (result.type === "deployment-failed") {
    await reporter.show({
      title: "Deployment failed",
      tone: "danger",
      text: `Shepherd remains online.\n\n${result.message}`,
    });
    return;
  }

  if (result.type === "restart-already-scheduled") {
    await reporter.show({ title: "Restart already scheduled", tone: "warning", text: "No additional restart was requested." });
    return;
  }

  const activity = formatRuntimeActivity(result.activity);
  if (result.action === "deploy" && result.stage === "after-quiescing" && result.deployment) {
    await reporter.show({
      title: "Deployment validated; restart deferred",
      tone: "warning",
      text: [
        `Validated commit \`${result.deployment.deployedCommit.slice(0, 7)}\`, but Codex work started during deployment.`,
        activity,
        "Run `!restart` when the work is complete.",
      ].filter(Boolean).join("\n"),
    });
    return;
  }

  await reporter.show({
    title: `${result.action === "restart" ? "Restart" : "Deployment"} refused`,
    tone: "warning",
    text: `Codex work is active.\n${activity}`,
  });
}

async function listStoredThreads(message: Message, context: CommandContext, archived: boolean): Promise<void> {
  const result = await context.conversation.listStoredThreads({ archived, limit: 25 });
  if (result.threads.length === 0) {
    const text = archived ? "No archived threads." : "No active threads.";
    await replyEmbed(
      message,
      buildEmbed({
        title: archived ? "Archived threads" : "Active threads",
        description: text,
        tone: "neutral",
      }),
      text,
    );
    return;
  }

  const lines = result.threads.map((thread, index) => {
    const label = thread.name ?? (thread.preview.slice(0, 48) || "untitled");
    return `${index + 1}. ${thread.threadId} | ${label} | updated ${formatTimestamp(thread.updatedAt)}`;
  });
  const text = lines.join("\n");
  await replyEmbedPages(
    message,
    buildDescriptionPages({
      title: archived ? "Archived threads" : "Active threads",
      text,
      tone: archived ? "neutral" : "info",
      footer: `${result.threads.length} thread${result.threads.length === 1 ? "" : "s"}`,
    }),
    text,
  );
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

function skillEmbeds(value: unknown): APIEmbed[] {
  const payload = asRecord(value);
  const entries = Array.isArray(payload.data) ? payload.data : [];
  if (entries.length === 0) {
    return [buildEmbed({ title: "Skills", description: "No skills found.", tone: "neutral" })];
  }
  const lines: string[] = [];
  let skillCount = 0;
  for (const entry of entries) {
    const record = asRecord(entry);
    const cwd = asString(record.cwd) ?? "unknown";
    const skills = Array.isArray(record.skills) ? record.skills : [];
    const errors = Array.isArray(record.errors) ? record.errors : [];
    lines.push(`**${cwd}**`);
    for (const skillValue of skills) {
      skillCount += 1;
      const skill = asRecord(skillValue);
      const name = asString(skill.name) ?? "unknown";
      const scope = asString(skill.scope) ?? "unknown";
      const enabled = skill.enabled === true ? "enabled" : "disabled";
      const description = asString(skill.description) ?? "";
      lines.push(`• \`${name}\` — ${scope}, **${enabled}**${description ? `\n  ${description}` : ""}`);
    }
    for (const errorValue of errors) {
      const error = asRecord(errorValue);
      lines.push(`⚠️ ${asString(error.message) ?? "unknown error"} (${asString(error.path) ?? "unknown path"})`);
    }
    lines.push("");
  }
  return buildDescriptionPages({
    title: "Skills",
    text: lines.join("\n"),
    footer: `${skillCount} skill${skillCount === 1 ? "" : "s"}`,
  });
}

function helpEmbed(): APIEmbed {
  return buildEmbed({
    title: "Shepherd commands",
    description: "Conversation messages follow the channel's listening mode.",
    fields: [
      {
        name: "Conversation",
        value: "`!status` · `!listen [open|mentions]` · `!pause` · `!resume` · `!detach` · `!interrupt`",
      },
      {
        name: "Workspace and thread",
        value: "`!repo [target]` · `!newthread` · `!threads [loaded|archived]` · `!thread [id]` · `!threadname <name>` · `!threadread [id]` · `!fork [id]`",
      },
      {
        name: "Thread lifecycle",
        value: "`!archive [id]` · `!unarchive <id>` · `!rollback <turns> [id]` · `!compact [id]`",
      },
      {
        name: "Model and account",
        value: "`!limits` · `!context` · `!models` · `!model` · `!model set <id>`",
      },
      {
        name: "Skills and runtime",
        value: "`!skills [reload]` · `!skill enable <name-or-path>` · `!skill disable <name-or-path>` · `!restart` · `!deploy`",
      },
    ],
  });
}

export async function handleMessage(
  message: Message,
  context: CommandContext,
  contentOverride?: string,
): Promise<HandleResult> {
  const inputContent = contentOverride ?? message.content;
  if (!inputContent.trim()) {
    return { handled: false, threadId: context.getSurfaceThreadId(message.channelId), input: null };
  }

  const content = inputContent.trim();
  const channelId = message.channelId;
  const { command, args } = parseThreadArgs(content);

  if (command === "!help") {
    const helpText = [
      "Discord Shepherd commands:",
      "- !help",
      "- !status",
      "- !listen [open|mentions]",
      "- !pause",
      "- !resume",
      "- !detach",
      "- !newthread",
      "- !repo",
      "- !repo <owner>/<repo>",
      "- !limits",
      "- !models",
      "- !model",
      "- !model set <id>",
      "- !context",
      "- !skills [reload]",
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
      "- !restart",
      "- !deploy",
      "Conversation messages follow the channel's listening mode.",
    ].join("\n");
    await replyEmbed(message, helpEmbed(), helpText);
    return { handled: true, threadId: null, input: null };
  }

  if (command === "!status") {
    if (args.length > 0) {
      await message.reply("Usage: !status");
      return { handled: true, threadId: null, input: null };
    }
    const status = formatSurfaceStatus(message, context);
    await replyEmbed(message, surfaceStatusEmbed(message, context), status);
    return { handled: true, threadId: context.getSurfaceThreadId(channelId), input: null };
  }

  if (command === "!listen") {
    const requestedMode = (args[0] ?? "").toLowerCase();
    if (!requestedMode) {
      const status = formatListeningStatus(message, context);
      await replyEmbed(message, listeningStatusEmbed(message, context), status);
      return { handled: true, threadId: context.getSurfaceThreadId(channelId), input: null };
    }
    if (args.length !== 1 || !["open", "mention", "mentions"].includes(requestedMode)) {
      await message.reply("Usage: !listen [open|mentions]");
      return { handled: true, threadId: null, input: null };
    }
    if ((requestedMode === "mention" || requestedMode === "mentions") && message.guildId === null) {
      await message.reply("Direct messages are always open. Use `!pause` to stop conversation input.");
      return { handled: true, threadId: context.getSurfaceThreadId(channelId), input: null };
    }
    if (requestedMode === "open" && !context.getSurfaceThreadId(channelId)) {
      await message.reply(
        "Start or attach a thread before opening this channel. Use `!newthread` or `!thread <id>`.",
      );
      return { handled: true, threadId: null, input: null };
    }
    const mode = context.setSurfaceListeningMode(
      channelId,
      requestedMode === "open" ? "open" : "mention",
    );
    await message.reply(
      mode === "open"
        ? "Listening is now **open**. Human text and images in this channel will be sent to the active thread."
        : "This channel is now **mention-only**. Use `@Shepherd` or a control command.",
    );
    return { handled: true, threadId: context.getSurfaceThreadId(channelId), input: null };
  }

  if (command === "!pause") {
    if (args.length > 0) {
      await message.reply("Usage: !pause");
      return { handled: true, threadId: null, input: null };
    }
    context.pauseSurfaceListening(channelId);
    await message.reply(
      "Paused. New conversation messages and attachments will be ignored; control commands remain available. The current Codex turn is unaffected.",
    );
    return { handled: true, threadId: context.getSurfaceThreadId(channelId), input: null };
  }

  if (command === "!resume") {
    if (args.length > 0) {
      await message.reply("Usage: !resume");
      return { handled: true, threadId: null, input: null };
    }
    const mode = context.resumeSurfaceListening(channelId);
    await message.reply(`Resumed in **${displayListeningMode(mode)}** mode.`);
    return { handled: true, threadId: context.getSurfaceThreadId(channelId), input: null };
  }

  if (command === "!detach") {
    if (args.length > 0) {
      await message.reply("Usage: !detach");
      return { handled: true, threadId: null, input: null };
    }
    const threadId = context.getSurfaceThreadId(channelId);
    if (!threadId) {
      await message.reply("No thread is attached to this channel.");
      return { handled: true, threadId: null, input: null };
    }
    context.clearSurfaceThread(channelId);
    await message.reply(
      `Channel detached from thread ${threadId}. The Codex thread was retained and can be reattached with \`!thread ${threadId}\`.`,
    );
    return { handled: true, threadId: null, input: null };
  }

  if (command === "!restart") {
    if (args.length > 0) {
      await message.reply("Usage: !restart");
      return { handled: true, threadId: null, input: null };
    }
    if (!context.runtimeLifecycle) {
      await message.reply("Runtime lifecycle controls are unavailable.");
      return { handled: true, threadId: null, input: null };
    }

    const reporter = new RuntimeEmbedReporter(message);
    const result = await context.runtimeLifecycle.restart({
      announce: async () => {
        await reporter.show({
          title: "Restarting Shepherd",
          tone: "success",
          text: formatRecoveryInstructions(context, channelId),
        });
      },
    });
    await replyRuntimeLifecycleResult(reporter, result);
    return { handled: true, threadId: null, input: null };
  }

  if (command === "!deploy") {
    if (args.length > 0) {
      await message.reply("Usage: !deploy");
      return { handled: true, threadId: null, input: null };
    }
    if (!context.runtimeLifecycle) {
      await message.reply("Runtime lifecycle controls are unavailable.");
      return { handled: true, threadId: null, input: null };
    }

    const reporter = new RuntimeEmbedReporter(message);
    const result = await context.runtimeLifecycle.deploy({
      onDeploymentStarted: async () => {
        await reporter.show({
          title: "Checking deployment",
          tone: "working",
          text: "Fetching the latest merged `origin/main` and validating the deployed checkout…",
        });
      },
      announce: async (announcement) => {
        if (announcement.action !== "deploy") {
          throw new Error("Deployment completed with an invalid lifecycle announcement.");
        }
        const { deployment } = announcement;
        const summary = deployment.changed
          ? `Deploy validated: ${deployment.previousCommit.slice(0, 7)} → ${deployment.deployedCommit.slice(0, 7)}`
          : `Deploy validated: already at ${deployment.deployedCommit.slice(0, 7)}`;
        await reporter.show({
          title: "Deployment validated",
          tone: "success",
          text: `${summary}\nRestarting Shepherd.\n\n${formatRecoveryInstructions(context, channelId)}`,
        });
      },
    });
    await replyRuntimeLifecycleResult(reporter, result);
    return { handled: true, threadId: null, input: null };
  }

  if (command === "!threads") {
    const mode = (args[0] ?? "").toLowerCase();
    if (mode === "loaded") {
      const loaded = await context.conversation.listLoadedThreads({ limit: 100 });
      const text = loaded.threadIds.length > 0
        ? `Loaded threads (${loaded.threadIds.length}):\n${loaded.threadIds.join("\n")}`
        : "No loaded threads.";
      await replyEmbedPages(
        message,
        buildDescriptionPages({
          title: "Loaded threads",
          text: loaded.threadIds.length > 0
            ? loaded.threadIds.map((threadId) => `• \`${threadId}\``).join("\n")
            : "No loaded threads.",
          footer: `${loaded.threadIds.length} loaded`,
        }),
        text,
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
    const text = formatRateLimitsForDiscord(result.rateLimits);
    await replyEmbed(message, rateLimitsEmbed(result.rateLimits), text);
    return { handled: true, threadId: null, input: null };
  }

  if (command === "!models") {
    const result = await executeControlAction(context, { type: "models.list", channelId });
    if (result.type !== "models.list") {
      throw new Error("Unexpected control action result for models.list.");
    }
    const text = formatModelsForDiscord(result.models, result.modelState);
    await replyEmbedPages(message, modelEmbeds(result.models, result.modelState), text);
    return { handled: true, threadId: result.modelState?.threadId ?? null, input: null };
  }

  if (command === "!model") {
    const subcommand = (args[0] ?? "").toLowerCase();
    const threadId = context.getSurfaceThreadId(channelId);
    if (!threadId) {
      await message.reply("No active thread in this channel yet. Use !newthread first.");
      return { handled: true, threadId: null, input: null };
    }

    if (!subcommand) {
      const model = context.conversation.getThreadModel(threadId);
      await replyEmbed(message, threadModelEmbed(model), formatThreadModelForDiscord(model));
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
    const text = formatThreadContextForDiscord(result.threadId, result.tokenUsage);
    await replyEmbed(message, threadContextEmbed(result.threadId, result.tokenUsage), text);
    return { handled: true, threadId: result.threadId, input: null };
  }

  if (command === "!newthread") {
    const result = await executeControlAction(context, { type: "thread.create", channelId });
    if (result.type !== "thread.create") {
      throw new Error("Unexpected control action result for thread.create.");
    }
    await message.reply(`Started new thread: ${result.threadId}`);
    return { handled: true, threadId: result.threadId, input: null };
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
    const activeThreadId = context.getSurfaceThreadId(channelId);
    if (!activeThreadId) {
      await message.reply("No active thread in this channel. Use !newthread or !thread <id> first.");
      return { handled: true, threadId: null, input: null };
    }

    const mode = (args[0] ?? "").toLowerCase();
    const forceReload = mode === "reload";
    const listed = await context.conversation.listSkills(activeThreadId, { forceReload });
    const text = formatSkillsForDiscord(listed);
    await replyEmbedPages(message, skillEmbeds(listed), text);
    return { handled: true, threadId: null, input: null };
  }

  if (command === "!skill") {
    const activeThreadId = context.getSurfaceThreadId(channelId);
    if (!activeThreadId) {
      await message.reply("No active thread in this channel. Use !newthread or !thread <id> first.");
      return { handled: true, threadId: null, input: null };
    }

    const sub = (args[0] ?? "").toLowerCase();
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

    const result = await executeControlAction(context, {
      type: "thread.switch",
      channelId,
      threadId: requestedThreadId,
    });
    if (result.type !== "thread.switch") {
      throw new Error("Unexpected control action result for thread.switch.");
    }
    await message.reply(`Switched active thread to: ${result.threadId}`);
    return { handled: true, threadId: result.threadId, input: null };
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
    const threadText = [
      `Thread: ${thread.id ?? threadId}`,
      `Name: ${thread.name ?? "untitled"}`,
      `Updated: ${formatTimestamp(typeof thread.updatedAt === "number" ? thread.updatedAt : null)}`,
      `Preview: ${(thread.preview ?? "").slice(0, 300) || "(empty)"}`,
    ].join("\n");
    await replyEmbed(
      message,
      buildEmbed({
        title: "Thread",
        fields: [
          { name: "ID", value: `\`${thread.id ?? threadId}\`` },
          { name: "Name", value: thread.name ?? "untitled", inline: true },
          {
            name: "Updated",
            value: formatTimestamp(typeof thread.updatedAt === "number" ? thread.updatedAt : null),
            inline: true,
          },
          { name: "Preview", value: (thread.preview ?? "").slice(0, 300) || "(empty)" },
        ],
      }),
      threadText,
    );
    return { handled: true, threadId, input: null };
  }

  if (command === "!fork") {
    const result = await executeControlAction(context, {
      type: "thread.fork",
      channelId,
      sourceThreadId: args[0],
    });
    if (result.type !== "thread.fork") {
      throw new Error("Unexpected control action result for thread.fork.");
    }
    if (!result.ok) {
      await message.reply(result.message);
      return { handled: true, threadId: null, input: null };
    }
    await message.reply(`Forked thread ${result.sourceThreadId} -> ${result.threadId}`);
    return { handled: true, threadId: result.threadId, input: null };
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

  const threadId = await context.ensureSurfaceThread(channelId);
  return { handled: false, threadId, input: [toTextUserInput(content)] };
}
