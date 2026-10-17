import { assertThreadSupport, assertInputSupport } from "../../../shared/protocol/provider_support.js";
import { approvalChoices } from "../approval_choices.js";
import { ClaudeTranscript, decodeTranscript, promptContent, textItemId } from "./transcript.js";
import { itemPage, paginate, sessionInfo, storedTurns, threadRecord, turnPage } from "./history.js";
import { claudeDefaults, claudeEffortLevels, isClaudeEffort, type ClaudeEffort } from "./defaults.js";
import { claudeModelCatalog } from "./model_catalog.js";
import { BackgroundTasks } from "./background_tasks.js";
import { shepherdMcpServers } from "./mcp_bridge.js";
import { claudeActivity, claudeActivityFields } from "./activity.js";
import { bypassProfile, claudePermissionOptions } from "./permissions.js";
import { claudeQuestions, claudeQuestionAnswers } from "./questions.js";
import type { UserQuestionRequest } from "../../../shared/protocol/user_questions.js";
import { claudeCapabilities } from "./capabilities.js";
import { InputQueue } from "./input_queue.js";
import { ClaudeModelCache } from "./model_cache.js";
import { archivedTag, claudeNative, type ClaudeNative } from "./native_sessions.js";
import { randomUUID } from "node:crypto";
import type { ModelInfo, ModelUsage, Options, Query, SDKUserMessage, PermissionResult, CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import type * as P from "../../../shared/protocol/requests.js";
import type { ApprovalDecisionRequest } from "../../../shared/protocol/approvals.js";
import { bridgeEvent, type BridgeEventPayloads, type BridgeEventType } from "../../../shared/protocol/events.js";
import type { UserInput } from "../../../shared/protocol/user_input.js";
import { UnsupportedProviderOperationError, type ProviderThreadRequest, type ThreadSession, type ThreadBootstrapInfo, type TurnSettings } from "../../ports/provider_session.js";
import { noProviderTools, type ProviderTools } from "../../ports/provider_tools.js";
import { claudeExecutablePath } from "./claude_executable.js";
import { claudeAuthenticationOptions } from "./authentication.js";
import type { ClaudeLimitsObserver } from "./account_limits.js";
import { EventBus } from "../event_bus.js";

type RequestUsage = { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };

/** Context fill of one model request, not the turn aggregate on the result message. */
function requestBreakdown(usage: RequestUsage): P.TokenUsageBreakdown {
  // Aggregate input includes cache reads/writes; absent components cannot be counted as zero.
  const cacheRead = usage.cache_read_input_tokens ?? null, cacheWrite = usage.cache_creation_input_tokens ?? null;
  const inputTokens = usage.input_tokens == null || cacheRead === null || cacheWrite === null
    ? null : usage.input_tokens + cacheRead + cacheWrite;
  const outputTokens = usage.output_tokens ?? null;
  // Per-request usage does not separate thinking from output.
  return { inputTokens, cacheReadInputTokens: cacheRead, cacheWriteInputTokens: cacheWrite, outputTokens, reasoningOutputTokens: null, totalTokens: inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null };
}

/** The conversation this session runs. Claude's session is the record; these are this process's
 * working settings, and changes requested before the session exists natively. */
type ClaudeThread = {
  id: string; cwd: string; model: string; effort: ClaudeEffort | undefined; materialized: boolean;
  createdAt: number; pending: { name?: string; archived?: boolean };
};

/** Native discovery options for reading the model list. */
export function catalogQueryOptions(cwd?: string, model?: string): Options {
  return { cwd: cwd ?? process.cwd(), model: model ?? claudeDefaults().model, ...(claudeExecutablePath() ? { pathToClaudeCodeExecutable: claudeExecutablePath() } : {}), permissionMode: "dontAsk" };
}

/** Claude's model list can only be read through a CLI process; the cache shares one copy per login. */
export function claudeSupportedModels(cache: ClaudeModelCache, open: (input: InputQueue<SDKUserMessage>) => Query, close: (running: Query) => void): Promise<ModelInfo[]> {
  return cache.get(async () => {
    const running = open(new InputQueue<SDKUserMessage>());
    try { return await running.supportedModels(); }
    finally { close(running); }
  });
}

export function claudeModelPage(models: ModelInfo[], request: P.ListModelsRequest): P.ListModelsResponse {
  const catalog = claudeModelCatalog(models, claudeDefaults()).filter(model => request.includeHidden || !model.hidden);
  const page = paginate(catalog, request);
  return { data: page.data, nextCursor: page.nextCursor };
}

export class ClaudeSession implements ThreadSession {
  readonly capabilities = claudeCapabilities;
  readonly sessionId = randomUUID();
  readonly eventBus = new EventBus();
  activeTurnId: string | null = null;
  /** The policy profile the thread runs with; null leaves Claude's configured permission mode. */
  profile: string | null = null;
  private readonly backgroundTasks = new BackgroundTasks();
  get backgroundTaskCount() { return this.backgroundTasks.count; }
  private thread: ClaudeThread | null = null;
  /** This process's turns, decoded with the same decoder as stored sessions. */
  private transcript = this.newTranscript();
  private running: Query | null = null;
  private readonly ownedQueries = new Map<Query, InputQueue<SDKUserMessage>>();
  private input: InputQueue<SDKUserMessage> | null = null;
  private stopped = false;
  private counter = 0;
  private interrupted = false;
  /** The task run whose notification wakes the next turn. Claude records that notification with
   * the run's ID, so the wake turn has the same ID after a reload. */
  private wakeRunId: string | null = null;
  private steeredMessages = 0;
  private requestUsage: RequestUsage | null = null;
  private runningTools: string | null = null;
  private approvals = new Map<string, { resolve: (result: PermissionResult) => void; input: Record<string, unknown>; suggestions: Parameters<CanUseTool>[2]["suggestions"]; questions?: UserQuestionRequest; replies: Map<string, unknown> }>();
  constructor(
    private readonly dynamicTools: ProviderTools = noProviderTools,
    private readonly sdk: ClaudeNative = claudeNative,
    private readonly accountLimits?: ClaudeLimitsObserver,
    private readonly modelCache = new ClaudeModelCache(),
    /** The provider's running sessions by thread, so it reaches a live thread through its session. */
    private readonly liveSessions = new Map<string, ClaudeSession>(),
  ) {}
  async initialize(): Promise<void> { if (this.stopped) throw new Error("Session is stopped."); }
  private newTranscript(): ClaudeTranscript {
    return new ClaudeTranscript((stage, turnId, item) => { if (!this.stopped) this.publish(stage === "started" ? "item.started" : "item.completed", { turnId, item }); });
  }
  private bootstrap(): ThreadBootstrapInfo {
    const thread = this.requireThread();
    return { threadId: thread.id, cwd: thread.cwd, model: thread.model, effort: thread.effort ?? null, profile: this.profile };
  }
  async startThread(request: ProviderThreadRequest): Promise<ThreadBootstrapInfo> {
    await this.initialize();
    this.validateOverrides(request);
    const defaults = claudeDefaults();
    this.bind({ id: randomUUID(), materialized: false, cwd: request.cwd ?? process.cwd(), model: request.model ?? defaults.model, effort: request.effort as ClaudeEffort | undefined ?? defaults.effort, createdAt: Date.now() / 1000, pending: {} });
    this.publish("thread.started", {});
    return this.bootstrap();
  }
  /** Claude's session records the conversation, not Shepherd's settings: a resumed conversation
   * uses the requested settings or the host defaults, and the model it last used. */
  async resumeThread(id: string, request: ProviderThreadRequest): Promise<ThreadBootstrapInfo> {
    await this.initialize(); this.validateOverrides(request);
    const info = await sessionInfo(this.sdk, id);
    const { model, usage } = decodeTranscript(await this.sdk.getSessionMessages(id));
    const defaults = claudeDefaults();
    this.bind({ id, materialized: true, cwd: request.cwd ?? info.cwd ?? process.cwd(), model: request.model ?? model ?? defaults.model, effort: request.effort as ClaudeEffort | undefined ?? defaults.effort, createdAt: (info.createdAt ?? info.lastModified) / 1000, pending: {} });
    if (usage) this.publish("thread.tokenUsage.updated", { turnId: null, tokenUsage: { last: requestBreakdown(usage as RequestUsage), total: null, contextWindow: null } });
    return this.bootstrap();
  }
  async forkThread(id: string, request: ProviderThreadRequest): Promise<ThreadBootstrapInfo> {
    await this.initialize(); this.validateOverrides(request);
    const info = await this.sdk.getSessionInfo(id);
    // The transcript stays in the project directory where it began. A thread's cwd can
    // later move to another workspace, so let the SDK search every project directory.
    const native = info ? (await this.sdk.forkSession(id)).sessionId : randomUUID();
    const { model } = info ? decodeTranscript(await this.sdk.getSessionMessages(native)) : { model: null };
    const defaults = claudeDefaults();
    this.bind({ id: native, materialized: !!info, cwd: request.cwd ?? info?.cwd ?? process.cwd(), model: request.model ?? model ?? defaults.model, effort: request.effort as ClaudeEffort | undefined ?? defaults.effort, createdAt: Date.now() / 1000, pending: {} });
    return this.bootstrap();
  }
  private bind(thread: ClaudeThread): void {
    if (this.thread && this.liveSessions.get(this.thread.id) === this) this.liveSessions.delete(this.thread.id);
    this.thread = thread; this.transcript = this.newTranscript();
    this.liveSessions.set(thread.id, this);
  }
  /** Claude's session does not record Shepherd's profile, so every bootstrap states the one to use. */
  private validateOverrides(request: ProviderThreadRequest) {
    assertThreadSupport("Claude", this.capabilities, request);
    claudePermissionOptions(request.profile ?? null);
    this.profile = request.profile ?? null;
    if (request.effort && !isClaudeEffort(request.effort)) throw new Error(`Claude effort must be one of ${claudeEffortLevels.join(", ")}.`);
  }
  async startTurn(input: UserInput[], { model, effort }: TurnSettings = {}): Promise<string> {
    await this.initialize();
    if (this.activeTurnId) throw new Error("A Claude turn is already active.");
    const thread = this.requireThread();
    assertInputSupport("Claude", this.capabilities, input);
    if (effort && !isClaudeEffort(effort)) throw new Error(`Claude effort must be one of ${claudeEffortLevels.join(", ")}.`);
    const message = this.userMessage(input);
    const settingsChanged = (model && model !== thread.model) || (effort !== undefined && (effort ?? undefined) !== thread.effort);
    // The SDK fixes MCP tools when its process starts; reopen when Shepherd tools change.
    const tools = JSON.stringify(this.dynamicTools.specifications());
    const toolsChanged = this.runningTools !== null && tools !== this.runningTools;
    if (this.running && (settingsChanged || toolsChanged)) {
      if (this.backgroundTaskCount) {
        if (settingsChanged) throw new Error("Wait for background tasks before changing Claude session settings.");
      } else { this.closeQuery(this.running); this.running = null; this.input = null; }
    }
    const options: Options = {
      cwd: thread.cwd, model: model ?? thread.model, effort: effort === null ? undefined : (effort as ClaudeEffort | undefined) ?? thread.effort,
      ...(thread.materialized ? { resume: thread.id } : { sessionId: thread.id }),
      ...(claudeExecutablePath() ? { pathToClaudeCodeExecutable: claudeExecutablePath() } : {}),
      // Subagents' text and thinking are forwarded so their work appears inside the delegation.
      includePartialMessages: true, forwardSubagentText: true, settingSources: ["user", "project", "local"],
      // Thinking text is omitted unless requested; summaries are what these models return.
      extraArgs: { "thinking-display": "summarized" },
      systemPrompt: { type: "preset", preset: "claude_code" },
      ...claudePermissionOptions(this.profile),
      canUseTool: (name, args, context) => this.requestApproval(name, args, context),
      mcpServers: shepherdMcpServers(this.dynamicTools, () => this.activeTurnId ? { threadId: thread.id, turnId: this.activeTurnId } : null),
    };
    const existing = this.running;
    const queue = this.input ?? new InputQueue<SDKUserMessage>();
    const running = existing ?? this.openQuery(queue, options);
    thread.cwd = options.cwd!; thread.model = options.model!; thread.effort = options.effort;
    // The prompt's ID is recorded in Claude's transcript, so the turn has the same ID after a reload.
    const turn = this.transcript.beginTurn(message.uuid!, Date.now() / 1000, promptContent(message.message.content));
    this.input = queue; this.running = running; this.activeTurnId = turn.id; this.interrupted = false; this.steeredMessages = 0; this.wakeRunId = null;
    this.publishSettings();
    this.publish("turn.started", { turnId: turn.id });
    queue.push(message);
    if (!existing) { this.runningTools = tools; this.backgroundTasks.reset(); void this.consume(running, queue); }
    return turn.id;
  }
  private userMessage(input: UserInput[]): SDKUserMessage {
    const content = input.map((part) => {
      if (part.type === "text") return { type: "text" as const, text: part.text };
      if (part.type === "image") {
        const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/s.exec(part.url);
        if (match) return { type: "image" as const, source: { type: "base64" as const, media_type: match[1] as "image/png", data: match[2]! } };
        if (/^https?:\/\//.test(part.url)) return { type: "image" as const, source: { type: "url" as const, url: part.url } };
      }
      throw new UnsupportedProviderOperationError("Claude", `input type ${part.type}`);
    });
    if (!content.length) throw new Error("Claude turn input is empty.");
    return { type: "user", uuid: randomUUID(), session_id: this.requireThread().id, message: { role: "user", content }, parent_tool_use_id: null };
  }
  private async consume(running: Query, queue: InputQueue<SDKUserMessage>) {
    let streamItemId: string | null = null;
    let streamMessageId: string | null = null;
    let streamTextBlocks = 0;
    // Thinking streams as reasoning. History records only thinking with text, so an item ID is
    // assigned, in the decoder's order, once a block's text is more than whitespace.
    let streamThinkingBlocks = 0, thinking: { itemId: string | null; text: string } | null = null;
    const scope = this.accountLimits?.scope();
    const account = this.accountLimits && typeof running.accountInfo === "function"
      ? running.accountInfo().catch(() => null) : Promise.resolve(null);
    try {
      for await (const message of { [Symbol.asyncIterator]: () => running }) {
        if (this.stopped || this.running !== running) break;
        if (message.type === "rate_limit_event" && this.accountLimits && scope) {
          // Account telemetry must not block or fail the model stream.
          void account.then(identity => {
            if (identity && !this.stopped && this.running === running) this.accountLimits?.observe(message.rate_limit_info, identity, scope);
          }).catch(() => {});
          continue;
        }
        if (message.type === "system" && message.subtype === "task_notification" && message.run_id && !message.skip_transcript && !this.transcript.current) this.wakeRunId ??= message.run_id;
        if (this.backgroundTasks.accept(message)) this.publish("thread.status.changed", { status: { state: this.activeTurnId ? "active" : "idle", backgroundTaskCount: this.backgroundTaskCount } });
        if (!this.transcript.current && ((message.type === "stream_event" && !message.parent_tool_use_id && message.event.type === "message_start") || (message.type === "assistant" && !message.parent_tool_use_id))) {
          this.beginWakeTurn();
        }
        const turn = this.transcript.current;
        if (message.type === "system" && message.subtype === "init") this.materialize(message.session_id);
        if (message.type === "stream_event" && !message.parent_tool_use_id) {
          const event = message.event;
          if (event.type === "message_start") {
            streamMessageId = streamItemId = event.message.id; streamTextBlocks = 0; streamThinkingBlocks = 0;
            this.requestUsage = { ...event.message.usage };
          }
          if (event.type === "content_block_start" && event.content_block.type === "text" && streamMessageId) streamItemId = textItemId(streamMessageId, streamTextBlocks++);
          if (event.type === "content_block_start") thinking = event.content_block.type === "thinking" ? { itemId: null, text: "" } : null;
          if (turn && thinking && streamMessageId && event.type === "content_block_delta" && event.delta.type === "thinking_delta") {
            thinking.text += event.delta.thinking;
            const first = !thinking.itemId && !!thinking.text.trim();
            if (first) thinking.itemId = `${streamMessageId}:thinking:${streamThinkingBlocks++}`;
            if (thinking.itemId) this.publish("item.delta", { turnId: turn.id, itemId: thinking.itemId, channel: "reasoning", form: "summary", delta: first ? thinking.text : event.delta.thinking, phase: null });
          }
          if (event.type === "message_delta" && this.requestUsage) {
            for (const [key, value] of Object.entries(event.usage ?? {})) if (typeof value === "number") (this.requestUsage as Record<string, number>)[key] = value;
          }
          if (turn && event.type === "content_block_delta" && event.delta.type === "text_delta") this.publish("item.delta", { turnId: turn.id, itemId: streamItemId, channel: "message", delta: event.delta.text, phase: null });
        }
        if (message.type === "assistant" && !message.parent_tool_use_id) {
          if (!this.requestUsage && message.message.usage) this.requestUsage = { ...message.message.usage };
          this.transcript.assistant(message.message);
        }
        if (message.type === "user" && !message.parent_tool_use_id) this.transcript.toolResults(message.message.content);
        if ((message.type === "assistant" || message.type === "user") && message.parent_tool_use_id) this.transcript.subagent(message.parent_tool_use_id, message.type, message.message);
        if (message.type === "result") {
          // A result ends the response to the queued input, so its last text is an answer.
          this.transcript.answered();
          const last = this.requestUsage ? requestBreakdown(this.requestUsage) : null;
          this.requestUsage = null;
          const rows = Object.values(message.modelUsage);
          const sum = (pick: (usage: ModelUsage) => number) => rows.length && rows.every(usage => Number.isFinite(pick(usage)))
            ? rows.reduce((acc, usage) => acc + pick(usage), 0) : null;
          const inputTokens = sum(usage => usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens), outputTokens = sum(usage => usage.outputTokens);
          const total: P.TokenUsageBreakdown = rows.length ? {
            inputTokens, cacheReadInputTokens: sum(usage => usage.cacheReadInputTokens), cacheWriteInputTokens: sum(usage => usage.cacheCreationInputTokens), outputTokens,
            // Thinking counts are optional per model; report them only when every row has one.
            reasoningOutputTokens: rows.length && rows.every(usage => typeof usage.thinkingTokens === "number") ? sum(usage => usage.thinkingTokens ?? 0) : null,
            totalTokens: inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null,
          } : requestBreakdown(message.usage);
          this.publish("thread.tokenUsage.updated", { turnId: turn?.id ?? null, tokenUsage: { last, total, contextWindow: this.contextWindow(message.modelUsage) } });
          if (message.is_error) throw new Error(message.subtype === "success" ? message.result : message.errors.join("\n"));
          if ((message.queued_turn_count ?? 0) === 0 && turn) this.finishTurn(this.interrupted ? "interrupted" : "completed");
        }
      }
      if (this.running === running && this.transcript.current && !this.interrupted && !this.stopped) throw new Error("Claude stream ended before a turn result.");
    } catch (error) {
      if (this.running === running && this.transcript.current) this.finishTurn(this.interrupted || this.stopped ? "interrupted" : "failed", error);
      else if (!this.stopped && this.running === running) this.publish("session.error", { message: String(error) });
    } finally {
      this.closeQuery(running);
      if (this.running === running) {
        if (this.transcript.current) this.finishTurn("interrupted");
        this.running = null; this.input = null;
        const hadBackgroundTasks = this.backgroundTaskCount > 0;
        this.backgroundTasks.reset();
        if (hadBackgroundTasks) this.publish("thread.status.changed", { status: { state: this.activeTurnId ? "active" : "idle", backgroundTaskCount: 0 } });
      }
    }
  }
  /** The SDK created the session; apply what was requested before it existed. */
  private materialize(nativeId: string): void {
    const thread = this.requireThread();
    if (thread.materialized) return;
    // Claude keeps the session ID Shepherd chose, which is already the conversation's identity.
    if (nativeId !== thread.id) this.publish("session.error", { message: `Claude started session ${nativeId} instead of ${thread.id}; its history may be unavailable.` });
    thread.materialized = true;
    const { name, archived } = thread.pending; thread.pending = {};
    if (name !== undefined) void this.sdk.renameSession(nativeId, name).catch(error => this.publish("session.error", { message: `Could not rename the Claude session: ${String(error)}` }));
    if (archived) void this.sdk.tagSession(nativeId, archivedTag).catch(error => this.publish("session.error", { message: `Could not archive the Claude session: ${String(error)}` }));
  }
  /** Background work can wake the session without a prompt. The transcript records the task
   * notification that caused it, whose ID this process does not see, so after a reload the turn
   * has that notification's ID. */
  private beginWakeTurn(): void {
    if (this.transcript.current) return;
    const turn = this.transcript.beginTurn(this.wakeRunId ?? randomUUID(), Date.now() / 1000, null);
    this.wakeRunId = null;
    this.activeTurnId = turn.id; this.interrupted = false;
    this.publish("turn.started", { turnId: turn.id });
  }
  private finishTurn(status: "completed" | "interrupted" | "failed", error?: unknown): void {
    if (!this.transcript.current) return;
    this.requestUsage = null; this.activeTurnId = null; this.denyPendingApprovals();
    const message = error && status === "failed" ? (error instanceof Error ? error.message : String(error)) : undefined;
    const turn = this.transcript.finish(status, Date.now() / 1000, message)!;
    if (!this.stopped) {
      if (turn.status === "failed") this.publish("turn.failed", { turnId: turn.id, message: turn.error?.message ?? "Turn failed." });
      else this.publish("turn.completed", { turnId: turn.id, ...(turn.status === "interrupted" ? { interrupted: true } : {}) });
    }
  }
  private contextWindow(usage: Record<string, ModelUsage>): number | null {
    const model = this.requireThread().model;
    const rows = Object.entries(usage);
    const main = rows.find(([key, row]) => key === model || row.canonicalModel === model)
      // Aliases such as "opus" match no key; the main model carries most of the context.
      ?? rows.sort(([, a], [, b]) => (b.inputTokens + b.cacheReadInputTokens) - (a.inputTokens + a.cacheReadInputTokens))[0];
    const window = main?.[1].contextWindow;
    return typeof window === "number" && window > 0 ? window : null;
  }
  private requestApproval(name: string, input: Record<string, unknown>, context: Parameters<CanUseTool>[2]): Promise<PermissionResult> {
    if (context.signal.aborted || this.stopped || !this.running) return Promise.resolve({ behavior: "deny", message: "Turn is no longer active." });
    if (!this.activeTurnId) this.beginWakeTurn();
    if (this.profile === bypassProfile && name !== "AskUserQuestion") return Promise.resolve({ behavior: "allow", updatedInput: input });
    const approvalId = randomUUID();
    const questions = name === "AskUserQuestion" ? claudeQuestions(input, this.requireThread().id, this.activeTurnId!, approvalId) : undefined;
    const suggestions = context.suppressAlwaysAllowRule ? undefined : context.suggestions?.map(update => ({ ...update, destination: "session" as const }));
    const offered = approvalChoices(questions
      ? [{ value: "submit", label: "Submit answers", intent: "answer" }, { value: "cancel", label: "Skip questions", intent: "cancel" }]
      : [{ value: "allow", label: "Allow once", intent: "allow" }, ...(suggestions?.length ? [{ value: "allow_session", label: "Allow for session", intent: "allow" as const }] : []), { value: "deny", label: "Deny", intent: "deny" }]);
    return new Promise((resolve) => {
      const deny = () => { if (this.approvals.delete(approvalId)) this.publish("approval.expired", { approvalId }); resolve({ behavior: "deny", message: "Approval interrupted." }); };
      context.signal.addEventListener("abort", deny, { once: true });
      this.approvals.set(approvalId, { input, suggestions, questions, replies: offered.replies, resolve: (result) => { context.signal.removeEventListener("abort", deny); resolve(result); } });
      this.publish("approval.requested", questions
        ? { approvalId, kind: "question", choices: offered.choices, userInput: questions }
        : { approvalId, kind: "permission", choices: offered.choices, activity: claudeActivity(name, claudeActivityFields(input)), reason: context.decisionReason ?? context.description ?? null });
    });
  }
  async applyApprovalDecision(approvalId: string, decision: ApprovalDecisionRequest) {
    const pending = this.approvals.get(approvalId);
    if (!pending) throw new Error("Unknown Claude approval.");
    const nativeDecision = pending.replies.get(decision.decision);
    if (typeof nativeDecision !== "string") throw new Error("Decision must match an offered option.");
    decision = { ...decision, decision: nativeDecision };
    if (pending.questions) {
      if (decision.decision !== "submit" && decision.decision !== "cancel") throw new Error("Invalid Claude question decision.");
      const answers = decision.decision === "submit" ? claudeQuestionAnswers(pending.questions, decision.answers) : null;
      this.approvals.delete(approvalId);
      pending.resolve(answers ? { behavior: "allow", updatedInput: { ...pending.input, answers } } : { behavior: "deny", message: "User skipped the questions." });
      return { approvalId };
    }
    if (decision.decision === "allow_session" && !pending.suggestions?.length) throw new Error("Session approval is unavailable for this request.");
    if (!["allow", "allow_session", "deny"].includes(decision.decision)) throw new Error("Invalid Claude approval decision.");
    this.approvals.delete(approvalId);
    pending.resolve(decision.decision === "allow" || decision.decision === "allow_session" ? { behavior: "allow", updatedInput: pending.input, ...(decision.decision === "allow_session" ? { updatedPermissions: pending.suggestions } : {}) } : { behavior: "deny", message: decision.reason ?? "Denied by user." });
    return { approvalId };
  }
  async steerTurn(input: UserInput[], turnId?: string): Promise<string> {
    assertInputSupport("Claude", this.capabilities, input);
    if (!this.input || !this.activeTurnId || (turnId && turnId !== this.activeTurnId)) throw new Error("No matching active Claude turn.");
    const message = this.userMessage(input);
    this.input.push(message); this.steeredMessages++;
    this.transcript.steer(message.uuid!, promptContent(message.message.content));
    return this.activeTurnId;
  }
  async interruptTurn(turnId?: string): Promise<void> {
    if (!this.running || !this.activeTurnId || (turnId && turnId !== this.activeTurnId)) throw new Error("No matching active Claude turn.");
    this.interrupted = true; this.denyPendingApprovals();
    const running = this.running;
    const receipt = await running.interrupt();
    // The public SDK can report surviving queued inputs but cannot cancel them.
    // Close that transport so a stopped turn cannot later run queued steering.
    if ((receipt?.still_queued.length ?? 0) > 0 || (!receipt && this.steeredMessages > 0)) {
      if (this.running === running) {
        this.closeQuery(running); this.running = null; this.input = null;
        this.finishTurn("interrupted"); this.backgroundTasks.reset();
        this.publish("thread.status.changed", { status: { state: this.activeTurnId ? "active" : "idle", backgroundTaskCount: 0 } });
      }
    }
  }
  /** Whether `id` is this session's conversation before Claude has created its session. */
  private unmaterialized(id: string): ClaudeThread | null {
    return this.thread?.id === id && !this.thread.materialized ? this.thread : null;
  }
  /** A conversation's turns, from Claude's transcript. Turns this process is running stay in
   * progress, including any the transcript has not recorded yet. */
  private async turns(id: string): Promise<P.HistoryTurn[]> {
    if (this.unmaterialized(id)) return this.transcript.snapshot();
    const live = this.thread?.id === id;
    const turns = await storedTurns(this.sdk, id, live ? this.activeTurnId : null);
    const current = live ? this.transcript.snapshot().at(-1) : undefined;
    if (current?.status === "in_progress" && !turns.some(turn => turn.id === current.id)) return [...turns, current];
    return turns;
  }
  async readThread(id: string, includeTurns: boolean) {
    const thread = this.unmaterialized(id);
    if (thread) return { thread: { id, model: thread.model, name: thread.pending.name ?? null, preview: "", createdAt: thread.createdAt, updatedAt: thread.createdAt, cwd: thread.cwd, ...(includeTurns ? { turns: this.transcript.snapshot() } : {}) } };
    const info = await sessionInfo(this.sdk, id);
    const live = this.thread?.id === id ? this.thread : null;
    const record = threadRecord(info, includeTurns ? await this.turns(id) : null, live?.model ?? null);
    return { thread: live ? { ...record, cwd: live.cwd } : record };
  }
  async listThreadTurns(id: string, request: P.ListThreadTurnsRequest) { return turnPage(await this.turns(id), request); }
  async listThreadItems(id: string, request: P.ListThreadItemsRequest) { return itemPage(await this.turns(id), request); }
  async setThreadName(id: string, name: string) {
    const thread = this.unmaterialized(id);
    if (thread) thread.pending.name = name; else await this.sdk.renameSession(id, name);
    this.publish("thread.name.updated", { threadName: name }, id);
  }
  async archiveThread(id: string) { await this.setArchived(id, true); this.publish("thread.archived", {}, id); }
  async unarchiveThread(id: string) { await this.setArchived(id, false); this.publish("thread.unarchived", {}, id); }
  private async setArchived(id: string, archived: boolean) {
    const thread = this.unmaterialized(id);
    if (thread) thread.pending.archived = archived; else await this.sdk.tagSession(id, archived ? archivedTag : null);
  }
  setCwd(cwd: string): void {
    const thread = this.requireThread();
    if (thread.cwd === cwd) return;
    if (this.activeTurnId || this.backgroundTaskCount) throw new Error("Wait for Claude work to finish before changing the working directory.");
    if (this.running) { this.closeQuery(this.running); this.running = null; this.input = null; }
    thread.cwd = cwd;
    this.publishSettings();
  }
  private publishSettings(): void {
    const thread = this.requireThread();
    this.publish("thread.settings.changed", { model: thread.model, effort: thread.effort ?? null, cwd: thread.cwd, profile: this.profile });
  }
  async listModels(request: P.ListModelsRequest): Promise<P.ListModelsResponse> {
    await this.initialize();
    return claudeModelPage(await this.supportedModels(), request);
  }
  /** Model and effort controls look up the catalog often; each uncached lookup starts a CLI process. */
  private supportedModels(): Promise<ModelInfo[]> {
    return claudeSupportedModels(this.modelCache, input => this.openQuery(input, catalogQueryOptions(this.thread?.cwd, this.thread?.model)), running => this.closeQuery(running));
  }
  stop(): void {
    if (this.thread && this.liveSessions.get(this.thread.id) === this) this.liveSessions.delete(this.thread.id);
    this.stopped = true; this.interrupted = true;
    for (const running of this.ownedQueries.keys()) this.closeQuery(running);
    this.denyPendingApprovals(); this.finishTurn("interrupted"); this.backgroundTasks.reset();
  }
  private openQuery(input: InputQueue<SDKUserMessage>, options: Options): Query {
    const running = this.sdk.query({ prompt: input, options: { ...options, ...claudeAuthenticationOptions() } });
    this.ownedQueries.set(running, input);
    return running;
  }
  private closeQuery(running: Query): void {
    const input = this.ownedQueries.get(running);
    if (!input) return;
    this.ownedQueries.delete(running); input.close(); running.close();
  }
  private denyPendingApprovals() { for (const [approvalId, pending] of this.approvals) { pending.resolve({ behavior: "deny", message: "Turn ended." }); this.publish("approval.expired", { approvalId }); } this.approvals.clear(); }
  private requireThread(): ClaudeThread { if (!this.thread) throw new Error("Claude thread is not bound."); return this.thread; }
  private publish<K extends BridgeEventType>(type: K, payload: BridgeEventPayloads[K], id = this.requireThread().id) { this.eventBus.publish(bridgeEvent({ id: `${this.sessionId}:${++this.counter}`, type, payload, threadId: id, sessionId: this.sessionId, ts: new Date().toISOString() })); }
}
