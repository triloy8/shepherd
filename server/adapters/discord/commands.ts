import { MessageFlags, type Message, type MessageEditOptions } from "discord.js";

import { executeControlAction } from "../../core/control_actions_service.js";
import type { ConversationService } from "../../core/conversation_service.js";
import type {
  RuntimeLifecycleOrchestrator,
  RuntimeLifecycleResult,
} from "../../core/runtime_lifecycle_orchestrator.js";
import type { RuntimeActivity } from "../../core/session_manager.js";
import type { SurfaceListeningMode } from "../../core/surface_state_service.js";
import type { ThreadModelState } from "../../../shared/protocol/requests.js";
import type { UserInput } from "../../../shared/protocol/user_input.js";
import { toTextUserInput } from "../../../shared/protocol/user_input.js";
import {
  buildCardPages,
  componentsV2Payload,
  type DiscordSurfacePage,
  type SurfaceTone,
} from "./components_renderer.js";
import {
  buildLoadedThreadsListPage,
  buildModelsListPage,
  buildStoredThreadsListPage,
  DISCORD_LIST_PAGE_SIZE,
} from "./list_pagination.js";
import {
  replyDiscordCard,
  replyDiscordMarkdown,
  replyDiscordPages,
  type DiscordDeliveryResult,
} from "./stream_delivery.js";

type HandleResult = { handled: boolean; threadId: string | null; input: UserInput[] | null };
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

function formatSurfaceStatus(message: Message, context: CommandContext): string {
  const channelId = message.channelId;
  const threadId = context.getSurfaceThreadId(channelId);
  const project = context.getSurfaceProject(channelId);
  const lines = [
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

function formatRateLimitsForDiscord(value: unknown): string {
  const limits = asRecord(value);
  const planType = asString(limits.planType) ?? "unknown";
  const limitId = asString(limits.limitId) ?? "unknown";

  const credits = asRecord(limits.credits);
  const hasCredits = credits.hasCredits === true ? "yes" : "no";
  const unlimited = credits.unlimited === true ? "yes" : "no";
  const balance = asString(credits.balance) ?? "unknown";

  const lines = [
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
    `- Thread: ${modelState.threadId}`,
    `- Current: ${modelState.currentModel ?? "unknown"}`,
    `- Provider: ${modelState.modelProvider ?? "unknown"}`,
  ];
  if (modelState.pendingModel) {
    lines.push(`- Pending next turn: ${modelState.pendingModel}`);
  }
  return lines.join("\n");
}

function ensureDelivery(result: DiscordDeliveryResult): void {
  if (!result.success) throw new Error(result.error ?? "Discord delivery failed.");
}

async function replyMarkdown(message: Message, text: string): Promise<void> {
  ensureDelivery(await replyDiscordMarkdown(message, text));
}

async function replyCard(
  message: Message,
  title: string,
  text: string,
  tone: SurfaceTone = "info",
): Promise<void> {
  ensureDelivery(await replyDiscordCard(message, { title, text, tone }));
}

async function replyPage(message: Message, page: DiscordSurfacePage): Promise<void> {
  ensureDelivery(await replyDiscordPages(message, [page]));
}

class RuntimeSurfaceReporter {
  private current: { edit: (payload: MessageEditOptions) => Promise<unknown> } | null = null;

  constructor(private readonly message: Message) {}

  async show(options: { title: string; text: string; tone: SurfaceTone }): Promise<void> {
    const page = buildCardPages(options)[0]!;
    if (this.current) {
      await this.current.edit({
        flags: MessageFlags.IsComponentsV2,
        components: page.components,
        allowedMentions: { parse: [] },
      });
      return;
    }
    this.current = await this.message.reply(componentsV2Payload(page));
  }
}

async function replyRuntimeLifecycleResult(
  reporter: RuntimeSurfaceReporter,
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
  const result = await context.conversation.listStoredThreads({
    archived,
    limit: DISCORD_LIST_PAGE_SIZE,
    sortKey: "updated_at",
    sortDirection: "desc",
  });
  await replyPage(message, buildStoredThreadsListPage({
    result,
    archived,
    requesterId: message.author.id,
    page: 1,
    requestDirection: "desc",
  }));
}

function formatSkillsForDiscord(value: unknown): string {
  const payload = asRecord(value);
  const entries = Array.isArray(payload.data) ? payload.data : [];
  if (entries.length === 0) {
    return "No skills found.";
  }

  const lines: string[] = [];
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
      "Conversation messages follow the channel's listening mode.",
      "",
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
    ].join("\n");
    await replyCard(message, "Shepherd commands", helpText);
    return { handled: true, threadId: null, input: null };
  }

  if (command === "!status") {
    if (args.length > 0) {
      await replyMarkdown(message, "Usage: !status");
      return { handled: true, threadId: null, input: null };
    }
    const status = formatSurfaceStatus(message, context);
    await replyCard(message, "Shepherd channel", status);
    return { handled: true, threadId: context.getSurfaceThreadId(channelId), input: null };
  }

  if (command === "!listen") {
    const requestedMode = (args[0] ?? "").toLowerCase();
    if (!requestedMode) {
      const status = formatListeningStatus(message, context);
      await replyCard(
        message,
        "Listening",
        status,
        effectiveListeningMode(message, context) === "paused" ? "warning" : "info",
      );
      return { handled: true, threadId: context.getSurfaceThreadId(channelId), input: null };
    }
    if (args.length !== 1 || !["open", "mention", "mentions"].includes(requestedMode)) {
      await replyMarkdown(message, "Usage: !listen [open|mentions]");
      return { handled: true, threadId: null, input: null };
    }
    if ((requestedMode === "mention" || requestedMode === "mentions") && message.guildId === null) {
      await replyCard(
        message,
        "Listening",
        "Direct messages are always open. Use `!pause` to stop conversation input.",
        "neutral",
      );
      return { handled: true, threadId: context.getSurfaceThreadId(channelId), input: null };
    }
    if (requestedMode === "open" && !context.getSurfaceThreadId(channelId)) {
      await replyCard(
        message,
        "Thread required",
        "Start or attach a thread before opening this channel. Use `!newthread` or `!thread <id>`.",
        "warning",
      );
      return { handled: true, threadId: null, input: null };
    }
    const mode = context.setSurfaceListeningMode(
      channelId,
      requestedMode === "open" ? "open" : "mention",
    );
    await replyCard(
      message,
      "Listening updated",
      mode === "open"
        ? "Listening is now **open**. Human text and images in this channel will be sent to the active thread."
        : "This channel is now **mention-only**. Use `@Shepherd` or a control command.",
      "success",
    );
    return { handled: true, threadId: context.getSurfaceThreadId(channelId), input: null };
  }

  if (command === "!pause") {
    if (args.length > 0) {
      await replyMarkdown(message, "Usage: !pause");
      return { handled: true, threadId: null, input: null };
    }
    context.pauseSurfaceListening(channelId);
    await replyCard(
      message,
      "Listening paused",
      "Paused. New conversation messages and attachments will be ignored; control commands remain available. The current Codex turn is unaffected.",
      "warning",
    );
    return { handled: true, threadId: context.getSurfaceThreadId(channelId), input: null };
  }

  if (command === "!resume") {
    if (args.length > 0) {
      await replyMarkdown(message, "Usage: !resume");
      return { handled: true, threadId: null, input: null };
    }
    const mode = context.resumeSurfaceListening(channelId);
    await replyCard(
      message,
      "Listening resumed",
      `Resumed in **${displayListeningMode(mode)}** mode.`,
      "success",
    );
    return { handled: true, threadId: context.getSurfaceThreadId(channelId), input: null };
  }

  if (command === "!detach") {
    if (args.length > 0) {
      await replyMarkdown(message, "Usage: !detach");
      return { handled: true, threadId: null, input: null };
    }
    const threadId = context.getSurfaceThreadId(channelId);
    if (!threadId) {
      await replyCard(message, "Thread unavailable", "No thread is attached to this channel.", "warning");
      return { handled: true, threadId: null, input: null };
    }
    context.clearSurfaceThread(channelId);
    await replyCard(
      message,
      "Channel detached",
      `Channel detached from thread ${threadId}. The Codex thread was retained and can be reattached with \`!thread ${threadId}\`.`,
      "neutral",
    );
    return { handled: true, threadId: null, input: null };
  }

  if (command === "!restart") {
    if (args.length > 0) {
      await replyMarkdown(message, "Usage: !restart");
      return { handled: true, threadId: null, input: null };
    }
    if (!context.runtimeLifecycle) {
      await replyCard(message, "Control unavailable", "Runtime lifecycle controls are unavailable.", "warning");
      return { handled: true, threadId: null, input: null };
    }

    const reporter = new RuntimeSurfaceReporter(message);
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
      await replyMarkdown(message, "Usage: !deploy");
      return { handled: true, threadId: null, input: null };
    }
    if (!context.runtimeLifecycle) {
      await replyCard(message, "Control unavailable", "Runtime lifecycle controls are unavailable.", "warning");
      return { handled: true, threadId: null, input: null };
    }

    const reporter = new RuntimeSurfaceReporter(message);
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
      const loaded = await context.conversation.listLoadedThreads({ limit: DISCORD_LIST_PAGE_SIZE });
      await replyPage(message, buildLoadedThreadsListPage({
        ...loaded,
        requesterId: message.author.id,
        page: 1,
      }));
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
    await replyCard(message, "Rate limits", text);
    return { handled: true, threadId: null, input: null };
  }

  if (command === "!models") {
    const result = await executeControlAction(context, {
      type: "models.list",
      channelId,
      limit: DISCORD_LIST_PAGE_SIZE,
    });
    if (result.type !== "models.list") {
      throw new Error("Unexpected control action result for models.list.");
    }
    await replyPage(message, buildModelsListPage({
      result: result.models,
      modelState: result.modelState,
      requesterId: message.author.id,
      page: 1,
    }));
    return { handled: true, threadId: result.modelState?.threadId ?? null, input: null };
  }

  if (command === "!model") {
    const subcommand = (args[0] ?? "").toLowerCase();
    const threadId = context.getSurfaceThreadId(channelId);
    if (!threadId) {
      await replyCard(
        message,
        "Thread required",
        "No active thread in this channel yet. Use `!newthread` first.",
        "warning",
      );
      return { handled: true, threadId: null, input: null };
    }

    if (!subcommand) {
      const model = context.conversation.getThreadModel(threadId);
      await replyCard(message, "Model", formatThreadModelForDiscord(model));
      return { handled: true, threadId, input: null };
    }

    if (subcommand !== "set") {
      await replyMarkdown(message, "Usage: !model\nUsage: !model set <id>");
      return { handled: true, threadId, input: null };
    }

    const requestedModel = args.slice(1).join(" ").trim();
    if (!requestedModel) {
      await replyMarkdown(message, "Usage: !model set <id>");
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
      await replyCard(message, "Model update failed", result.message, "danger");
      return { handled: true, threadId, input: null };
    }

    await replyCard(
      message,
      "Model updated",
      `Model for thread ${result.threadId} set to \`${result.model}\`.\nApplies to the next new turn and subsequent turns.`,
      "success",
    );
    return { handled: true, threadId: result.threadId, input: null };
  }

  if (command === "!context") {
    const result = await executeControlAction(context, { type: "context.read", channelId });
    if (result.type !== "context.read") {
      throw new Error("Unexpected control action result for context.read.");
    }
    if (!result.ok) {
      await replyCard(message, "Context unavailable", result.message, "warning");
      return { handled: true, threadId: null, input: null };
    }
    if (!result.tokenUsage) {
      await replyCard(
        message,
        "Context unavailable",
        "No context telemetry yet for this thread. Send a turn first.",
        "neutral",
      );
      return { handled: true, threadId: result.threadId, input: null };
    }
    const text = formatThreadContextForDiscord(result.threadId, result.tokenUsage);
    await replyCard(message, "Context usage", text);
    return { handled: true, threadId: result.threadId, input: null };
  }

  if (command === "!newthread") {
    const result = await executeControlAction(context, { type: "thread.create", channelId });
    if (result.type !== "thread.create") {
      throw new Error("Unexpected control action result for thread.create.");
    }
    await replyCard(message, "Thread created", `Started new thread: ${result.threadId}`, "success");
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
      await replyCard(
        message,
        "Repository",
        current
          ? `Current repo for this channel: ${current}`
          : "No repo selected for this channel. Use `!repo <owner>/<repo>`, `!repo ~`, or `!repo ~/path`.",
        current ? "info" : "neutral",
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
    await replyCard(
      message,
      "Repository updated",
      configured.activeThreadId
        ? `Repo set for this channel: ${configured.repoSlug}\nNote: active thread ${configured.activeThreadId} keeps its current session/cwd; this repo applies to future !newthread/!fork.`
        : `Repo set for this channel: ${configured.repoSlug}`,
      "success",
    );
    return { handled: true, threadId: null, input: null };
  }

  if (command === "!skills") {
    const activeThreadId = context.getSurfaceThreadId(channelId);
    if (!activeThreadId) {
      await replyCard(
        message,
        "Thread required",
        "No active thread in this channel. Use `!newthread` or `!thread <id>` first.",
        "warning",
      );
      return { handled: true, threadId: null, input: null };
    }

    const mode = (args[0] ?? "").toLowerCase();
    const forceReload = mode === "reload";
    const listed = await context.conversation.listSkills(activeThreadId, { forceReload });
    const text = formatSkillsForDiscord(listed);
    await replyCard(message, "Skills", text);
    return { handled: true, threadId: null, input: null };
  }

  if (command === "!skill") {
    const activeThreadId = context.getSurfaceThreadId(channelId);
    if (!activeThreadId) {
      await replyCard(
        message,
        "Thread required",
        "No active thread in this channel. Use `!newthread` or `!thread <id>` first.",
        "warning",
      );
      return { handled: true, threadId: null, input: null };
    }

    const sub = (args[0] ?? "").toLowerCase();
    if (sub === "enable" || sub === "disable") {
      const requestedSkill = args.slice(1).join(" ").trim();
      if (!requestedSkill) {
        await replyMarkdown(message, `Usage: !skill ${sub} <name-or-path>`);
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
        await replyCard(message, "Skill update failed", result.message, "danger");
        return { handled: true, threadId: null, input: null };
      }
      await replyCard(
        message,
        result.enabled ? "Skill enabled" : "Skill disabled",
        `${result.enabled ? "Enabled" : "Disabled"} skill ${result.requestedSkill} (effectiveEnabled=${result.effectiveEnabled})`,
        result.enabled ? "success" : "neutral",
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
    await replyCard(
      message,
      "Thread",
      existing ? `Current thread: ${existing}` : "No thread yet. Send a message to start one.",
      existing ? "info" : "neutral",
    );
    return { handled: true, threadId: existing, input: null };
  }

  if (command === "!thread" && args.length > 0) {
    const requestedThreadId = args[0]?.trim();
    if (!requestedThreadId) {
      await replyMarkdown(message, "Usage: !thread <id>");
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
    await replyCard(message, "Thread switched", `Switched active thread to: ${result.threadId}`, "success");
    return { handled: true, threadId: result.threadId, input: null };
  }

  if (command === "!threadname") {
    const name = args.join(" ").trim();
    if (!name) {
      await replyMarkdown(message, "Usage: !threadname <name>");
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
      await replyCard(message, "Thread rename failed", result.message, "danger");
      return { handled: true, threadId: null, input: null };
    }
    await replyCard(message, "Thread renamed", `Thread renamed: ${result.name}`, "success");
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
      await replyCard(message, "Thread unavailable", result.message, "warning");
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
    await replyCard(message, "Thread", threadText);
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
      await replyCard(message, "Thread fork failed", result.message, "danger");
      return { handled: true, threadId: null, input: null };
    }
    await replyCard(
      message,
      "Thread forked",
      `Forked thread ${result.sourceThreadId} -> ${result.threadId}`,
      "success",
    );
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
      await replyCard(message, "Archive failed", result.message, "danger");
      return { handled: true, threadId: null, input: null };
    }
    await replyCard(message, "Thread archived", `Archived thread: ${result.threadId}`, "neutral");
    return { handled: true, threadId: result.threadId, input: null };
  }

  if (command === "!unarchive") {
    const target = args[0];
    if (!target) {
      await replyMarkdown(message, "Usage: !unarchive <id>");
      return { handled: true, threadId: null, input: null };
    }
    const result = await executeControlAction(context, {
      type: "thread.unarchive",
      threadId: target,
    });
    if (result.type !== "thread.unarchive") {
      throw new Error("Unexpected control action result for thread.unarchive.");
    }
    await replyCard(message, "Thread unarchived", `Unarchived thread: ${result.threadId}`, "success");
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
      await replyCard(message, "Rollback failed", result.message, "danger");
      return { handled: true, threadId: null, input: null };
    }
    await replyCard(
      message,
      "Thread rolled back",
      `Rolled back ${result.numTurns} turn(s) on ${result.threadId}`,
      "warning",
    );
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
      await replyCard(message, "Compaction failed", result.message, "danger");
      return { handled: true, threadId: null, input: null };
    }
    await replyCard(
      message,
      "Compaction started",
      `Started compaction for thread: ${result.threadId}`,
      "working",
    );
    return { handled: true, threadId: result.threadId, input: null };
  }

  if (command === "!interrupt") {
    if (args.length > 0) {
      await replyMarkdown(message, "Usage: !interrupt");
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
      await replyCard(message, "Interrupt failed", result.message, "danger");
      return { handled: true, threadId: null, input: null };
    }
    await replyCard(
      message,
      "Interrupt requested",
      `Interrupt requested for thread: ${result.threadId}`,
      "warning",
    );
    return { handled: true, threadId: result.threadId, input: null };
  }

  if (command.startsWith("!")) {
    await replyCard(
      message,
      "Unknown command",
      `Unknown command: \`${command}\`. Use \`!help\` to inspect available commands.`,
      "warning",
    );
    return { handled: true, threadId: null, input: null };
  }

  const threadId = await context.ensureSurfaceThread(channelId);
  return { handled: false, threadId, input: [toTextUserInput(content)] };
}
