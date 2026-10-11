import { assertThreadSupport, assertApprovalSupport, assertInputSupport } from "../../../shared/protocol/provider_support.js";
import { approvalChoices } from "../approval_choices.js";
import { historyContent, historyItem, historyTurn } from "./history.js";
import { claudeDefaults } from "./defaults.js";
import { claudeModelCatalog } from "./model_catalog.js";
import { BackgroundTasks } from "./background_tasks.js";
import { shepherdMcpServers } from "./mcp_bridge.js";
import { claudeQuestions, claudeQuestionAnswers } from "./questions.js";
import type { UserQuestionRequest } from "../../../shared/protocol/user_questions.js";
import { claudeCapabilities } from "./capabilities.js";
import { claudeEffortLevels, isClaudeEffort, type ClaudeThreadRepository, type ClaudeThread, type ClaudeThreadSummary } from "./thread_store.js";
import { InputQueue } from "./input_queue.js";
import { randomUUID } from "node:crypto";
import { query, forkSession, type ModelInfo, type ModelUsage, type Options, type Query, type SDKMessage, type SDKUserMessage, type PermissionResult, type CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import type * as P from "../../../shared/protocol/requests.js";
import type { ApprovalDecisionRequest } from "../../../shared/protocol/approvals.js";
import { bridgeEvent, type BridgeEventPayloads, type BridgeEventType } from "../../../shared/protocol/events.js";
import type { UserInput } from "../../../shared/protocol/user_input.js";
import { UnsupportedProviderOperationError, type ProviderSession, type ThreadBootstrapInfo } from "../../ports/provider_session.js";
import { noProviderTools, type ProviderTools } from "../../ports/provider_tools.js";
import { claudeExecutablePath } from "./claude_executable.js";
import { claudeAuthenticationOptions } from "./authentication.js";
import type { ClaudeLimitsObserver } from "./account_limits.js";
import { EventBus } from "../event_bus.js";

function paginate<T>(values: T[], request: { cursor?: string; limit?: number }) {
  const offset = request.cursor ? Number(request.cursor) : 0;
  const limit = request.limit ?? 20;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid Claude pagination.");
  return { data: values.slice(offset, offset + limit), nextCursor: offset + limit < values.length ? String(offset + limit) : null, backwardsCursor: null };
}

const modelCacheMs = 60_000;
const persistDelayMs = 1_000;
const storedResultChars = 8_000;

type RequestUsage = { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };

/** The CLI emits one assistant message per content block. Later text blocks of one API message need distinct item IDs. */
function textItemId(messageId: string, index: number): string { return index === 0 ? messageId : `${messageId}:${index}`; }

/** Context fill of one model request, not the turn aggregate on the result message. */
function requestBreakdown(usage: RequestUsage): P.TokenUsageBreakdown {
  const cached = usage.cache_read_input_tokens ?? 0;
  const inputTokens = (usage.input_tokens ?? 0) + cached + (usage.cache_creation_input_tokens ?? 0);
  const outputTokens = usage.output_tokens ?? 0;
  return { inputTokens, cachedInputTokens: cached, outputTokens, reasoningOutputTokens: 0, totalTokens: inputTokens + outputTokens };
}

/** The SDK transcript keeps full tool output. Shepherd history keeps a bounded preview. */
function storedToolResult(content: unknown): unknown {
  const text = (value: string) => value.length > storedResultChars ? `${value.slice(0, storedResultChars)}\n[${value.length - storedResultChars} characters omitted]` : value;
  if (typeof content === "string") return text(content);
  if (!Array.isArray(content)) return content;
  return content.map((block: { type?: unknown; text?: unknown }) => block?.type === "text" && typeof block.text === "string" ? { type: "text", text: text(block.text) } : { type: typeof block?.type === "string" ? block.type : "unknown", omitted: true });
}

export class ClaudeSession implements ProviderSession {
  readonly capabilities = claudeCapabilities;
  readonly sessionId = randomUUID();
  readonly eventBus = new EventBus();
  activeTurnId: string | null = null;
  private readonly backgroundTasks = new BackgroundTasks();
  get backgroundTaskCount() { return this.backgroundTasks.count; }
  private currentTurn: P.HistoryTurn | null = null;
  private thread: ClaudeThread | null = null;
  private running: Query | null = null;
  private readonly ownedQueries = new Map<Query, InputQueue<SDKUserMessage>>();
  private input: InputQueue<SDKUserMessage> | null = null;
  private stopped = false;
  private counter = 0;
  private interrupted = false;
  private steeredMessages = 0;
  private pendingText: Array<{ itemId: string; text: string; turn: P.HistoryTurn }> = [];
  private readonly textBlocks = new Map<string, number>();
  private requestUsage: RequestUsage | null = null;
  private runningTools: string | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private models: { value: ModelInfo[]; at: number } | null = null;
  private loadingModels: Promise<ModelInfo[]> | null = null;
  private approvals = new Map<string, { resolve: (result: PermissionResult) => void; input: Record<string, unknown>; suggestions: Parameters<CanUseTool>[2]["suggestions"]; questions?: UserQuestionRequest; replies: Map<string, unknown> }>();
  constructor(
    public approvalPolicy: P.ApprovalPolicy = "provider_default",
    private readonly dynamicTools: ProviderTools = noProviderTools,
    private readonly store: ClaudeThreadRepository,
    private readonly sdk = { query, forkSession },
    private readonly accountLimits?: ClaudeLimitsObserver,
  ) {}
  async initialize(): Promise<void> { if (this.stopped) throw new Error("Session is stopped."); }
  private bootstrap(): ThreadBootstrapInfo {
    const thread = this.requireThread();
    return { threadId: thread.id, model: thread.model, effort: thread.effort ?? null, approvalPolicy: this.approvalPolicy };
  }
  async startThread(request: P.CreateThreadRequest): Promise<ThreadBootstrapInfo> {
    await this.initialize();
    this.validateOverrides(request);
    const nativeId = randomUUID();
    const defaults = claudeDefaults();
    this.thread = { id: `claude-${nativeId}`, nativeId, materialized: false, cwd: request.cwd ?? process.cwd(), model: request.model ?? defaults.model, effort: request.effort as ClaudeThread["effort"] ?? defaults.effort, name: null, preview: "", archived: false, createdAt: Date.now() / 1000, updatedAt: Date.now() / 1000, instructions: request.instructions ?? "", turns: [] };
    this.approvalPolicy = request.approvalPolicy ?? this.approvalPolicy;
    this.persist();
    this.publish("thread.started", { approvalPolicy: this.approvalPolicy });
    return this.bootstrap();
  }
  async resumeThread(id: string, request: P.ResumeThreadRequest): Promise<ThreadBootstrapInfo> {
    await this.initialize(); this.validateOverrides(request);
    this.thread = this.store.read(id);
    // A process crash leaves the last turn incomplete; retain it as interrupted.
    for (const turn of this.thread.turns) if (turn.status === "in_progress") turn.status = "interrupted";
    if (request.cwd) this.thread.cwd = request.cwd;
    if (request.model) this.thread.model = request.model;
    if (request.effort) this.thread.effort = request.effort as ClaudeThread["effort"];
    if (request.instructions !== undefined) this.thread.instructions = request.instructions;
    this.approvalPolicy = (request.approvalPolicy === "provider_default" ? undefined : request.approvalPolicy) ?? this.thread.approvalMode ?? this.approvalPolicy;
    assertApprovalSupport("Claude", this.capabilities, this.approvalPolicy);
    this.persist();
    if (this.thread.tokenUsage) this.publish("thread.tokenUsage.updated", { turnId: null, tokenUsage: this.thread.tokenUsage });
    return this.bootstrap();
  }
  async forkThread(id: string, request: P.ForkThreadRequest): Promise<ThreadBootstrapInfo> {
    await this.initialize(); this.validateOverrides(request);
    const source = this.store.read(id);
    const policy = (request.approvalPolicy === "provider_default" ? undefined : request.approvalPolicy) ?? source.approvalMode ?? this.approvalPolicy;
    assertApprovalSupport("Claude", this.capabilities, policy);
    if (source.turns.some(turn => turn.status === "in_progress")) throw new Error("Cannot fork an active Claude thread.");
    // The transcript stays in the project directory where it began. A thread's cwd can
    // later move to another workspace, so let the SDK search every project directory.
    const nativeId = source.materialized ? (await this.sdk.forkSession(source.nativeId)).sessionId : randomUUID();
    this.thread = { ...source, id: `claude-${nativeId}`, nativeId, name: null, archived: false, createdAt: Date.now() / 1000, turns: structuredClone(source.turns) };
    if (request.cwd) this.thread.cwd = request.cwd;
    if (request.model) this.thread.model = request.model;
    if (request.effort) this.thread.effort = request.effort as ClaudeThread["effort"];
    if (request.instructions !== undefined) this.thread.instructions = request.instructions;
    this.approvalPolicy = policy;
    this.persist(); return this.bootstrap();
  }
  private validateOverrides(request: P.CreateThreadRequest | P.ResumeThreadRequest) {
    assertThreadSupport("Claude", this.capabilities, request);
    assertApprovalSupport("Claude", this.capabilities, request.approvalPolicy ?? this.approvalPolicy);
    if (request.effort && !isClaudeEffort(request.effort)) throw new Error(`Claude effort must be one of ${claudeEffortLevels.join(", ")}.`);
  }
  async startTurn(input: UserInput[], policy?: P.ApprovalPolicy, model?: string, cwd?: string, effort?: string): Promise<string> {
    await this.initialize();
    if (this.activeTurnId) throw new Error("A Claude turn is already active.");
    const thread = this.requireThread();
    assertApprovalSupport("Claude", this.capabilities, policy ?? this.approvalPolicy);
    assertInputSupport("Claude", this.capabilities, input);
    if (effort && !isClaudeEffort(effort)) throw new Error(`Claude effort must be one of ${claudeEffortLevels.join(", ")}.`);
    const message = this.userMessage(input);
    const nextPolicy = policy === "provider_default" ? this.approvalPolicy : policy ?? this.approvalPolicy;
    const settingsChanged = (cwd && cwd !== thread.cwd) || (model && model !== thread.model) || (effort && effort !== thread.effort) || JSON.stringify(nextPolicy) !== JSON.stringify(this.approvalPolicy);
    // The SDK fixes MCP tools when its process starts; reopen when Shepherd tools change.
    const tools = JSON.stringify(this.dynamicTools.specifications());
    const toolsChanged = this.runningTools !== null && tools !== this.runningTools;
    if (this.running && (settingsChanged || toolsChanged)) {
      if (this.backgroundTaskCount) {
        if (settingsChanged) throw new Error("Wait for background tasks before changing Claude session settings.");
      } else { this.closeQuery(this.running); this.running = null; this.input = null; }
    }
    this.approvalPolicy = nextPolicy;
    const options: Options = {
      cwd: cwd ?? thread.cwd, model: model ?? thread.model, effort: (effort as ClaudeThread["effort"]) ?? thread.effort,
      ...(thread.materialized ? { resume: thread.nativeId } : { sessionId: thread.nativeId }),
      ...(claudeExecutablePath() ? { pathToClaudeCodeExecutable: claudeExecutablePath() } : {}),
      includePartialMessages: true, settingSources: ["user", "project", "local"],
      systemPrompt: { type: "preset", preset: "claude_code", append: thread.instructions || undefined },
      permissionMode: this.approvalPolicy === "bypass" ? "bypassPermissions" : "default",
      ...(this.approvalPolicy === "bypass" ? { allowDangerouslySkipPermissions: true } : {}),
      canUseTool: (name, args, context) => this.requestApproval(name, args, context),
      mcpServers: shepherdMcpServers(this.dynamicTools, () => this.activeTurnId ? { threadId: thread.id, turnId: this.activeTurnId } : null),
    };
    const existing = this.running;
    const queue = this.input ?? new InputQueue<SDKUserMessage>();
    const running = existing ?? this.openQuery(queue, options);
    thread.cwd = options.cwd!; thread.model = options.model!; thread.effort = options.effort;
    const turn: P.HistoryTurn = { id: randomUUID(), status: "in_progress", itemsView: "full", items: [{ id: message.uuid!, type: "user_message", content: historyContent(input) }], error: null, startedAt: Date.now() / 1000, completedAt: null, durationMs: null };
    thread.turns.push(turn); thread.preview ||= input.filter((part) => part.type === "text").map((part) => part.text).join("\n").slice(0, 200);
    this.input = queue; this.running = running; this.activeTurnId = turn.id; this.currentTurn = turn; this.interrupted = false; this.steeredMessages = 0;
    try { this.persist(); }
    catch (error) {
      this.closeQuery(running); thread.turns.pop(); this.backgroundTasks.reset();
      this.input = null; this.running = null; this.activeTurnId = null; this.currentTurn = null;
      throw error;
    }
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
    return { type: "user", uuid: randomUUID(), session_id: this.requireThread().nativeId, message: { role: "user", content }, parent_tool_use_id: null };
  }
  private async consume(running: Query, queue: InputQueue<SDKUserMessage>) {
    let streamItemId: string | null = null;
    let streamMessageId: string | null = null;
    let streamTextBlocks = 0;
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
        if (this.backgroundTasks.accept(message)) this.publish("thread.status.changed", { status: { state: this.activeTurnId ? "active" : "idle", backgroundTaskCount: this.backgroundTaskCount } });
        if (!this.currentTurn && ((message.type === "stream_event" && !message.parent_tool_use_id && message.event.type === "message_start") || (message.type === "assistant" && !message.parent_tool_use_id))) {
          this.beginWakeTurn();
        }
        const turn = this.currentTurn;
        if (message.type === "system" && message.subtype === "init") {
          this.requireThread().nativeId = message.session_id; this.requireThread().materialized = true; this.persist();
        }
        if (message.type === "stream_event" && !message.parent_tool_use_id) {
          const event = message.event;
          if (event.type === "message_start") {
            streamMessageId = streamItemId = event.message.id; streamTextBlocks = 0;
            this.requestUsage = { ...event.message.usage };
          }
          if (event.type === "content_block_start" && event.content_block.type === "text" && streamMessageId) streamItemId = textItemId(streamMessageId, streamTextBlocks++);
          if (event.type === "message_delta" && this.requestUsage) {
            for (const [key, value] of Object.entries(event.usage ?? {})) if (typeof value === "number") (this.requestUsage as Record<string, number>)[key] = value;
          }
        }
        if (message.type === "stream_event" && !message.parent_tool_use_id && turn) {
          if (message.event.type === "content_block_delta" && message.event.delta.type === "text_delta") this.publish("turn.stream.delta", { kind: "assistant_text", textDelta: message.event.delta.text, itemId: streamItemId, turnId: turn.id, phase: null });
        }
        if (message.type === "assistant" && !message.parent_tool_use_id && turn) this.assistantMessage(message, turn);
        if (message.type === "user" && !message.parent_tool_use_id && turn && Array.isArray(message.message.content)) {
          for (const block of message.message.content) if (block.type === "tool_result") {
            const item = turn.items.find((item) => item.id === block.tool_use_id);
            if (item?.type === "activity") {
              item.output = JSON.stringify(storedToolResult(block.content));
              item.activity.status = block.is_error ? "failed" : "completed";
              this.publish("turn.activity", { ...item.activity, detail: null });
            }
          }
          this.persistSoon();
        }
        if (message.type === "result") {
          // A result ends the response to the queued input, so its last text is an answer.
          this.flushText("final_answer");
          const last = requestBreakdown(this.requestUsage ?? message.usage);
          this.requestUsage = null;
          const total = Object.values(message.modelUsage).reduce((acc, usage) => {
            acc.inputTokens += usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
            acc.cachedInputTokens += usage.cacheReadInputTokens;
            acc.outputTokens += usage.outputTokens;
            acc.reasoningOutputTokens += usage.thinkingTokens ?? 0;
            acc.totalTokens = acc.inputTokens + acc.outputTokens;
            return acc;
          }, { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 });
          const tokenUsage: P.ThreadTokenUsage = { last, total, modelContextWindow: this.contextWindow(message.modelUsage) };
          this.requireThread().tokenUsage = tokenUsage;
          this.publish("thread.tokenUsage.updated", { turnId: turn?.id ?? null, tokenUsage });
          if (message.is_error) throw new Error(message.subtype === "success" ? message.result : message.errors.join("\n"));
          if ((message.queued_turn_count ?? 0) === 0 && turn) this.finishTurn(this.interrupted ? "interrupted" : "completed");
        }
      }
      if (this.running === running && this.currentTurn && !this.interrupted && !this.stopped) throw new Error("Claude stream ended before a turn result.");
    } catch (error) {
      if (this.running === running && this.currentTurn) this.finishTurn(this.interrupted || this.stopped ? "interrupted" : "failed", error);
      else if (!this.stopped && this.running === running) this.publish("session.error", { message: String(error) });
    } finally {
      this.closeQuery(running);
      if (this.running === running) {
        if (this.currentTurn) this.finishTurn("interrupted");
        this.running = null; this.input = null;
        const hadBackgroundTasks = this.backgroundTaskCount > 0;
        this.backgroundTasks.reset();
        if (hadBackgroundTasks) this.publish("thread.status.changed", { status: { state: this.activeTurnId ? "active" : "idle", backgroundTaskCount: 0 } });
      }
    }
  }
  private beginWakeTurn(): void {
    if (this.currentTurn) return;
    this.currentTurn = { id: randomUUID(), status: "in_progress", itemsView: "full", items: [], error: null, startedAt: Date.now() / 1000, completedAt: null, durationMs: null };
    this.requireThread().turns.push(this.currentTurn); this.activeTurnId = this.currentTurn.id; this.interrupted = false;
    this.persist(); this.publish("turn.started", { turnId: this.currentTurn.id });
  }
  private finishTurn(status: "completed" | "interrupted" | "failed", error?: unknown): void {
    const turn = this.currentTurn;
    if (!turn) return;
    this.flushText(status === "completed" ? "final_answer" : "commentary"); this.textBlocks.clear(); this.requestUsage = null;
    this.currentTurn = null; this.activeTurnId = null; this.denyPendingApprovals();
    turn.status = status;
    if (error && status === "failed") turn.error = { message: error instanceof Error ? error.message : String(error) };
    turn.completedAt = Date.now() / 1000; turn.durationMs = (turn.completedAt - turn.startedAt!) * 1000;
    try { this.persist(); } catch (error) { turn.status = "failed"; turn.error = { message: String(error) }; }
    if (!this.stopped) {
      if (turn.status === "failed") this.publish("turn.failed", { turnId: turn.id, message: turn.error?.message ?? "Turn failed." });
      else this.publish("turn.completed", { turnId: turn.id });
    }
  }
  /** Text is commentary when a tool call follows it and an answer when the response ends. */
  private assistantMessage(message: Extract<SDKMessage, { type: "assistant" }>, turn: P.HistoryTurn) {
    if (!this.requestUsage && message.message.usage) this.requestUsage = { ...message.message.usage };
    for (const block of message.message.content) {
      if (block.type === "text") {
        const index = this.textBlocks.get(message.message.id) ?? 0;
        this.textBlocks.set(message.message.id, index + 1);
        if (block.text) this.pendingText.push({ itemId: textItemId(message.message.id, index), text: block.text, turn });
      }
      if (block.type === "tool_use") {
        this.flushText("commentary");
        const kind = block.name === "Bash" ? "command" : ["Edit", "Write"].includes(block.name) ? "file_change" : "mcp_tool";
        turn.items.push({ id: block.id, type: "activity", activity: { itemId: block.id, turnId: turn.id, kind, label: block.name, detail: JSON.stringify(block.input), status: "started" } });
        this.publish("turn.activity", { itemId: block.id, turnId: turn.id, kind, label: block.name, detail: JSON.stringify(block.input), status: "started" });
      }
    }
    this.persistSoon();
  }
  private flushText(phase: "commentary" | "final_answer"): void {
    for (const pending of this.pendingText.splice(0)) {
      pending.turn.items.push({ id: pending.itemId, type: "assistant_message", text: pending.text, phase });
      if (!this.stopped) this.publish("turn.message.completed", { itemId: pending.itemId, turnId: pending.turn.id, phase, text: pending.text });
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
    if (this.approvalPolicy === "bypass" && name !== "AskUserQuestion") return Promise.resolve({ behavior: "allow", updatedInput: input });
    const approvalId = randomUUID();
    const questions = name === "AskUserQuestion" ? claudeQuestions(input, this.requireThread().id, this.activeTurnId!, approvalId) : undefined;
    const suggestions = context.suppressAlwaysAllowRule ? undefined : context.suggestions?.map(update => ({ ...update, destination: "session" as const }));
    const offered = approvalChoices(questions ? [{ value: "submit", label: "Submit answers" }, { value: "cancel", label: "Skip questions" }] : [{ value: "accept", label: "Allow once" }, ...(suggestions?.length ? [{ value: "acceptForSession", label: "Allow for session" }] : []), { value: "decline", label: "Deny" }]);
    return new Promise((resolve) => {
      const deny = () => { if (this.approvals.delete(approvalId)) this.publish("approval.expired", { approvalId }); resolve({ behavior: "deny", message: "Approval interrupted." }); };
      context.signal.addEventListener("abort", deny, { once: true });
      this.approvals.set(approvalId, { input, suggestions, questions, replies: offered.replies, resolve: (result) => { context.signal.removeEventListener("abort", deny); resolve(result); } });
      this.publish("approval.requested", { approvalId, kind: questions ? "question" : "permission", prompt: questions ? questions.questions.map(q => q.question).join("\n") : `Allow Claude to use ${name}?`,
        choices: offered.choices,
        detail: questions ? null : JSON.stringify(input, null, 2), ...(questions ? { userInput: questions } : {}) });
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
    if (decision.decision === "acceptForSession" && !pending.suggestions?.length) throw new Error("Session approval is unavailable for this request.");
    if (!["accept", "acceptForSession", "decline", "cancel"].includes(decision.decision)) throw new Error("Invalid Claude approval decision.");
    this.approvals.delete(approvalId);
    pending.resolve(decision.decision === "accept" || decision.decision === "acceptForSession" ? { behavior: "allow", updatedInput: pending.input, ...(decision.decision === "acceptForSession" ? { updatedPermissions: pending.suggestions } : {}) } : { behavior: "deny", message: decision.reason ?? "Denied by user." });
    return { approvalId };
  }
  async steerTurn(input: UserInput[], turnId?: string): Promise<string> {
    assertInputSupport("Claude", this.capabilities, input);
    if (!this.input || !this.activeTurnId || (turnId && turnId !== this.activeTurnId)) throw new Error("No matching active Claude turn.");
    const message = this.userMessage(input);
    this.input.push(message); this.steeredMessages++;
    this.requireThread().turns.at(-1)!.items.push({ id: message.uuid!, type: "user_message", content: historyContent(input) });
    this.persist(); return this.activeTurnId;
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
  async readThread(id: string, includeTurns: boolean) { const thread = this.thread?.id === id ? this.thread : this.store.read(id); return { thread: this.record(thread, includeTurns) }; }
  private record(thread: ClaudeThreadSummary & { turns?: P.HistoryTurn[] }, includeTurns = false): P.ThreadRecord { return { id: thread.id, name: thread.name, preview: thread.preview, createdAt: thread.createdAt, updatedAt: thread.updatedAt, cwd: thread.cwd, ...(includeTurns ? { turns: (thread.turns ?? []).map(historyTurn) } : {}) }; }
  async listStoredThreads(request: P.ListStoredThreadsRequest) {
    const threads = this.store.list().filter((t) => t.archived === (request.archived ?? false) && (!request.searchTerm || `${t.name ?? ""} ${t.preview}`.toLowerCase().includes(request.searchTerm.toLowerCase())) && (!request.cwd || (Array.isArray(request.cwd) ? request.cwd.includes(t.cwd) : request.cwd === t.cwd)));
    const key = request.sortKey === "created_at" ? "createdAt" : "updatedAt";
    threads.sort((a, b) => (request.sortDirection === "asc" ? 1 : -1) * (a[key] - b[key]));
    return paginate(threads.map((t) => this.record(t)), request);
  }
  async listLoadedThreads(request: P.ListLoadedThreadsRequest) { return paginate(this.thread ? [this.thread.id] : [], request); }
  async listThreadTurns(id: string, request: P.ListThreadTurnsRequest) {
    const thread = this.thread?.id === id ? this.thread : this.store.read(id);
    const turns = [...thread.turns]; if (request.sortDirection !== "asc") turns.reverse();
    return paginate(turns.map((turn) => ({ ...turn, itemsView: request.itemsView ?? "full", items: request.itemsView === "none" ? [] : turn.items.map(item => historyItem(item, turn.id)) })), request);
  }
  async listThreadItems(id: string, request: P.ListThreadItemsRequest) {
    const thread = this.thread?.id === id ? this.thread : this.store.read(id);
    const items = thread.turns.filter((t) => !request.turnId || t.id === request.turnId).flatMap((t) => t.items.map((item) => ({ turnId: t.id, item: historyItem(item, t.id) })));
    if (request.sortDirection === "desc") items.reverse(); return paginate(items, request);
  }
  async setThreadName(id: string, name: string) { const thread = this.thread?.id === id ? this.thread : this.store.read(id); thread.name = name; this.saveMutation(thread); this.publish("thread.name.updated", { threadName: name }, id); }
  async archiveThread(id: string) { const thread = this.thread?.id === id ? this.thread : this.store.read(id); thread.archived = true; this.saveMutation(thread); this.publish("thread.archived", {}, id); }
  async unarchiveThread(id: string) { const thread = this.thread?.id === id ? this.thread : this.store.read(id); thread.archived = false; this.saveMutation(thread); this.publish("thread.unarchived", {}, id); }
  setCwd(cwd: string): void {
    const thread = this.requireThread();
    if (thread.cwd === cwd) return;
    if (this.activeTurnId || this.backgroundTaskCount) throw new Error("Wait for Claude work to finish before changing the working directory.");
    if (this.running) { this.closeQuery(this.running); this.running = null; this.input = null; }
    thread.cwd = cwd; this.persist();
  }
  private saveMutation(thread: ClaudeThread) { thread.updatedAt = Date.now() / 1000; this.store.write(thread); }
  async listModels(request: P.ListModelsRequest): Promise<P.ListModelsResponse> {
    await this.initialize();
    const defaults = claudeDefaults();
    const catalog = claudeModelCatalog(await this.supportedModels(), defaults).filter(model => request.includeHidden || !model.hidden);
    const page = paginate(catalog, request);
    return { data: page.data, nextCursor: page.nextCursor };
  }
  /** Model and effort controls look up the catalog often; each uncached lookup starts a CLI process. */
  private supportedModels(): Promise<ModelInfo[]> {
    if (this.models && Date.now() - this.models.at < modelCacheMs) return Promise.resolve(this.models.value);
    if (!this.loadingModels) {
      const loading = (async () => {
        const running = this.openQuery(new InputQueue<SDKUserMessage>(), { cwd: this.thread?.cwd ?? process.cwd(), model: this.thread?.model ?? claudeDefaults().model, ...(claudeExecutablePath() ? { pathToClaudeCodeExecutable: claudeExecutablePath() } : {}), permissionMode: "dontAsk" });
        try {
          const value = await running.supportedModels();
          if (!this.stopped) this.models = { value, at: Date.now() };
          return value;
        } finally { this.closeQuery(running); }
      })();
      this.loadingModels = loading;
      void loading.catch(() => {}).finally(() => { if (this.loadingModels === loading) this.loadingModels = null; });
    }
    return this.loadingModels;
  }
  stop(): void {
    this.stopped = true; this.interrupted = true;
    for (const running of this.ownedQueries.keys()) this.closeQuery(running);
    this.denyPendingApprovals(); this.finishTurn("interrupted"); this.backgroundTasks.reset();
    if (this.persistTimer) { try { this.persist(); } catch { /* Shutdown continues; the SDK transcript is authoritative. */ } }
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
  private persist() {
    if (this.persistTimer) { clearTimeout(this.persistTimer); this.persistTimer = null; }
    const thread = this.requireThread(); thread.approvalMode = this.approvalPolicy; thread.updatedAt = Date.now() / 1000; this.store.write(thread);
  }
  /** Streamed blocks arrive quickly; coalesce their snapshot writes. Turn boundaries persist immediately. */
  private persistSoon() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      try { this.persist(); } catch (error) { if (!this.stopped) this.publish("session.error", { message: `Could not save Claude history: ${String(error)}` }); }
    }, persistDelayMs);
    this.persistTimer.unref?.();
  }
  private publish<K extends BridgeEventType>(type: K, payload: BridgeEventPayloads[K], id = this.requireThread().id) { this.eventBus.publish(bridgeEvent({ id: `${this.sessionId}:${++this.counter}`, type, payload, threadId: id, sessionId: this.sessionId, ts: new Date().toISOString() })); }
}
