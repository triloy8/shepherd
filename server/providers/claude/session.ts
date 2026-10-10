import { claudeDefaults } from "./defaults.js";
import { claudeModelCatalog } from "./model_catalog.js";
import { BackgroundTasks } from "./background_tasks.js";
import { shepherdMcpServers } from "./mcp_bridge.js";
import { claudeQuestions, claudeQuestionAnswers } from "./questions.js";
import type { UserQuestionRequest } from "../../../shared/protocol/user_questions.js";
import { claudeCapabilities } from "../capabilities.js";
import type { ClaudeThreadRepository, ClaudeThread } from "../../ports/claude_thread_store.js";
import { InputQueue } from "./input_queue.js";
import { randomUUID } from "node:crypto";
import { query, forkSession, type Options, type Query, type SDKMessage, type SDKUserMessage, type PermissionResult, type CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import type * as P from "../../../shared/protocol/requests.js";
import type { ApprovalDecisionRequest } from "../../../shared/protocol/approvals.js";
import type { BridgeEventType } from "../../../shared/protocol/events.js";
import type { UserInput } from "../../../shared/protocol/user_input.js";
import { UnsupportedProviderOperationError, type AgentSession, type ThreadBootstrapInfo } from "../../core/agent_session.js";
import { DynamicToolRegistry } from "../../core/dynamic_tool_registry.js";
import { claudeExecutablePath } from "./claude_executable.js";
import { claudeAuthenticationOptions } from "./authentication.js";
import type { ClaudeLimitsObserver } from "./account_limits.js";
import { EventBus } from "../../core/event_bus.js";

function paginate<T>(values: T[], request: { cursor?: string; limit?: number }) {
  const offset = request.cursor ? Number(request.cursor) : 0;
  const limit = request.limit ?? 20;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid Claude pagination.");
  return { data: values.slice(offset, offset + limit), nextCursor: offset + limit < values.length ? String(offset + limit) : null, backwardsCursor: null };
}

export class ClaudeSession implements AgentSession {
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
  private approvals = new Map<string, { resolve: (result: PermissionResult) => void; input: Record<string, unknown>; suggestions: Parameters<CanUseTool>[2]["suggestions"]; questions?: UserQuestionRequest }>();
  constructor(
    public approvalPolicy: P.ApprovalPolicy = "on-request",
    private readonly dynamicTools = new DynamicToolRegistry(),
    private readonly store: ClaudeThreadRepository,
    private readonly sdk = { query, forkSession },
    private readonly accountLimits?: ClaudeLimitsObserver,
  ) {}
  async initialize(): Promise<void> { if (this.stopped) throw new Error("Session is stopped."); }
  private bootstrap(): ThreadBootstrapInfo {
    const thread = this.requireThread();
    return { threadId: thread.id, model: thread.model, modelProvider: "anthropic", reasoningEffort: thread.effort ?? null, approvalPolicy: this.approvalPolicy };
  }
  async startThread(request: P.CreateThreadRequest): Promise<ThreadBootstrapInfo> {
    await this.initialize();
    this.validateOverrides(request);
    const nativeId = randomUUID();
    const defaults = claudeDefaults();
    this.thread = { id: `claude-${nativeId}`, nativeId, materialized: false, cwd: request.cwd ?? process.cwd(), model: request.model ?? defaults.model, effort: defaults.effort, name: null, preview: "", archived: false, createdAt: Date.now() / 1000, updatedAt: Date.now() / 1000, instructions: [request.baseInstructions, request.developerInstructions].filter(Boolean).join("\n\n"), turns: [] };
    this.approvalPolicy = request.approvalPolicy ?? this.approvalPolicy;
    this.persist();
    this.publish("thread.started", { approvalPolicy: this.approvalPolicy });
    return this.bootstrap();
  }
  async resumeThread(id: string, request: P.ResumeThreadRequest): Promise<ThreadBootstrapInfo> {
    await this.initialize(); this.validateOverrides(request);
    this.thread = this.store.read(id);
    // A process crash leaves the last turn incomplete; retain it as interrupted.
    for (const turn of this.thread.turns) if (turn.status === "inProgress") turn.status = "interrupted";
    if (request.cwd) this.thread.cwd = request.cwd;
    if (request.model) this.thread.model = request.model;
    if (request.baseInstructions !== undefined || request.developerInstructions !== undefined) this.thread.instructions = [request.baseInstructions, request.developerInstructions].filter(Boolean).join("\n\n");
    this.approvalPolicy = request.approvalPolicy ?? this.approvalPolicy;
    this.persist();
    if (this.thread.tokenUsage) this.publish("thread.tokenUsage.updated", { turnId: null, tokenUsage: this.thread.tokenUsage });
    return this.bootstrap();
  }
  async forkThread(id: string, request: P.ForkThreadRequest): Promise<ThreadBootstrapInfo> {
    await this.initialize(); this.validateOverrides(request);
    const source = this.store.read(id);
    if (source.turns.some(turn => turn.status === "inProgress")) throw new Error("Cannot fork an active Claude thread.");
    const nativeId = source.materialized ? (await this.sdk.forkSession(source.nativeId, { dir: source.cwd })).sessionId : randomUUID();
    this.thread = { ...source, id: `claude-${nativeId}`, nativeId, name: null, archived: false, createdAt: Date.now() / 1000, turns: structuredClone(source.turns) };
    if (request.cwd) this.thread.cwd = request.cwd;
    if (request.model) this.thread.model = request.model;
    if (request.baseInstructions !== undefined || request.developerInstructions !== undefined) this.thread.instructions = [request.baseInstructions, request.developerInstructions].filter(Boolean).join("\n\n");
    this.approvalPolicy = request.approvalPolicy ?? this.approvalPolicy;
    this.persist(); return this.bootstrap();
  }
  private validateOverrides(request: P.CreateThreadRequest | P.ResumeThreadRequest) {
    if (request.sandbox && request.sandbox !== "danger-full-access") throw new UnsupportedProviderOperationError("Claude", `sandbox mode ${request.sandbox}; use a sandboxed host or danger-full-access`);
    if (typeof request.approvalPolicy === "object") throw new UnsupportedProviderOperationError("Claude", "granular approval policies");
    if (request.config || request.modelProvider || request.personality) throw new UnsupportedProviderOperationError("Claude", "Codex config, modelProvider, or personality overrides");
    if ("ephemeral" in request && request.ephemeral) throw new UnsupportedProviderOperationError("Claude", "ephemeral threads");
  }
  async startTurn(input: UserInput[], policy?: P.ApprovalPolicy, model?: string, cwd?: string, effort?: string): Promise<string> {
    await this.initialize();
    if (this.activeTurnId) throw new Error("A Claude turn is already active.");
    const thread = this.requireThread();
    if (typeof policy === "object") throw new UnsupportedProviderOperationError("Claude", "granular approval policies");
    if (effort && !["low", "medium", "high", "xhigh", "max"].includes(effort)) throw new Error("Unsupported Claude effort.");
    const message = this.userMessage(input);
    const nextPolicy = policy ?? this.approvalPolicy;
    const settingsChanged = (cwd && cwd !== thread.cwd) || (model && model !== thread.model) || (effort && effort !== thread.effort) || JSON.stringify(nextPolicy) !== JSON.stringify(this.approvalPolicy);
    if (this.running && settingsChanged) {
      if (this.backgroundTaskCount) throw new Error("Wait for background tasks before changing Claude session settings.");
      this.closeQuery(this.running); this.running = null; this.input = null;
    }
    this.approvalPolicy = nextPolicy;
    const options: Options = {
      cwd: cwd ?? thread.cwd, model: model ?? thread.model, effort: (effort as Options["effort"]) ?? thread.effort,
      ...(thread.materialized ? { resume: thread.nativeId } : { sessionId: thread.nativeId }),
      ...(claudeExecutablePath() ? { pathToClaudeCodeExecutable: claudeExecutablePath() } : {}),
      includePartialMessages: true, settingSources: ["user", "project", "local"],
      systemPrompt: { type: "preset", preset: "claude_code", append: thread.instructions || undefined },
      permissionMode: this.approvalPolicy === "never" ? "bypassPermissions" : "default",
      ...(this.approvalPolicy === "never" ? { allowDangerouslySkipPermissions: true } : {}),
      canUseTool: (name, args, context) => this.requestApproval(name, args, context),
      mcpServers: shepherdMcpServers(this.dynamicTools, () => this.activeTurnId ? { threadId: thread.id, turnId: this.activeTurnId } : null),
    };
    const existing = this.running;
    const queue = this.input ?? new InputQueue<SDKUserMessage>();
    const running = existing ?? this.openQuery(queue, options);
    thread.cwd = options.cwd!; thread.model = options.model!; thread.effort = options.effort;
    const turn: P.HistoryTurn = { id: randomUUID(), status: "inProgress", itemsView: "full", items: [{ id: message.uuid!, type: "userMessage", content: input }], error: null, startedAt: Date.now() / 1000, completedAt: null, durationMs: null };
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
    if (!existing) { this.backgroundTasks.reset(); void this.consume(running, queue); }
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
        if (this.backgroundTasks.accept(message)) this.publish("thread.status.changed", { status: { backgroundTaskCount: this.backgroundTaskCount } });
        if (!this.currentTurn && ((message.type === "stream_event" && !message.parent_tool_use_id && message.event.type === "message_start") || (message.type === "assistant" && !message.parent_tool_use_id))) {
          this.beginWakeTurn();
        }
        const turn = this.currentTurn;
        if (message.type === "system" && message.subtype === "init") {
          this.requireThread().nativeId = message.session_id; this.requireThread().materialized = true; this.persist();
        }
        if (message.type === "stream_event" && !message.parent_tool_use_id && turn) {
          if (message.event.type === "message_start") streamItemId = message.event.message.id;
          if (message.event.type === "content_block_delta" && message.event.delta.type === "text_delta") this.publish("turn.stream.delta", { kind: "assistant_text", method: "claude/text_delta", textDelta: message.event.delta.text, itemId: streamItemId, turnId: turn.id, phase: null });
        }
        if (message.type === "assistant" && !message.parent_tool_use_id && turn) this.assistantMessage(message, turn);
        if (message.type === "user" && !message.parent_tool_use_id && turn && Array.isArray(message.message.content)) {
          for (const block of message.message.content) if (block.type === "tool_result") {
            const item = turn.items.find((item) => item.id === block.tool_use_id);
            if (item) {
              item.status = block.is_error ? "failed" : "completed";
              item.result = block.content;
              this.publish("turn.activity", { itemId: item.id, turnId: turn.id, kind: item.activityKind ?? "mcp_tool", label: String(item.tool), detail: null, status: item.status });
            }
          }
        }
        if (message.type === "result") {
          const usage = message.usage;
          const inputTokens = usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
          const last: P.TokenUsageBreakdown = { inputTokens, cachedInputTokens: usage.cache_read_input_tokens ?? 0, outputTokens: usage.output_tokens, reasoningOutputTokens: 0, totalTokens: inputTokens + usage.output_tokens };
          const total = Object.values(message.modelUsage).reduce((acc, usage) => {
            acc.inputTokens += usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
            acc.cachedInputTokens += usage.cacheReadInputTokens;
            acc.outputTokens += usage.outputTokens;
            acc.reasoningOutputTokens += usage.thinkingTokens ?? 0;
            acc.totalTokens = acc.inputTokens + acc.outputTokens;
            return acc;
          }, { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 });
          this.requireThread().tokenUsage = { last, total };
          this.publish("thread.tokenUsage.updated", { turnId: turn?.id ?? null, tokenUsage: { last, total } });
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
        if (hadBackgroundTasks) this.publish("thread.status.changed", { status: { backgroundTaskCount: 0 } });
      }
    }
  }
  private beginWakeTurn(): void {
    if (this.currentTurn) return;
    this.currentTurn = { id: randomUUID(), status: "inProgress", itemsView: "full", items: [], error: null, startedAt: Date.now() / 1000, completedAt: null, durationMs: null };
    this.requireThread().turns.push(this.currentTurn); this.activeTurnId = this.currentTurn.id; this.interrupted = false;
    this.persist(); this.publish("turn.started", { turnId: this.currentTurn.id });
  }
  private finishTurn(status: "completed" | "interrupted" | "failed", error?: unknown): void {
    const turn = this.currentTurn;
    if (!turn) return;
    this.currentTurn = null; this.activeTurnId = null; this.denyPendingApprovals();
    turn.status = status;
    if (error && status === "failed") turn.error = { message: error instanceof Error ? error.message : String(error) };
    turn.completedAt = Date.now() / 1000; turn.durationMs = (turn.completedAt - turn.startedAt!) * 1000;
    try { this.persist(); } catch (error) { turn.status = "failed"; turn.error = { message: String(error) }; }
    if (!this.stopped) this.publish(turn.status === "failed" ? "turn.failed" : "turn.completed", { turnId: turn.id, ...(turn.error ? { message: turn.error.message } : {}) });
  }
  private assistantMessage(message: Extract<SDKMessage, { type: "assistant" }>, turn: P.HistoryTurn) {
    const phase = message.message.content.some((block) => block.type === "tool_use") ? "commentary" : "final_answer";
    const text = message.message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    if (text) {
      const itemId = message.message.id;
      turn.items.push({ id: itemId, type: "agentMessage", text, phase });
      this.publish("turn.message.completed", { itemId, turnId: turn.id, phase, text });
    }
    for (const block of message.message.content) if (block.type === "tool_use") {
      const kind = block.name === "Bash" ? "command" : ["Edit", "Write"].includes(block.name) ? "file_change" : "mcp_tool";
      const item = { id: block.id, type: "mcpToolCall", server: "claude", tool: block.name, arguments: block.input, activityKind: kind };
      turn.items.push(item);
      this.publish("turn.activity", { itemId: block.id, turnId: turn.id, kind, label: block.name, detail: JSON.stringify(block.input), status: "started" });
    }
    this.persist();
  }
  private requestApproval(name: string, input: Record<string, unknown>, context: Parameters<CanUseTool>[2]): Promise<PermissionResult> {
    if (context.signal.aborted || this.stopped || !this.running) return Promise.resolve({ behavior: "deny", message: "Turn is no longer active." });
    if (!this.activeTurnId) this.beginWakeTurn();
    if (this.approvalPolicy === "never" && name !== "AskUserQuestion") return Promise.resolve({ behavior: "allow", updatedInput: input });
    const approvalId = randomUUID();
    const questions = name === "AskUserQuestion" ? claudeQuestions(input, this.requireThread().id, this.activeTurnId!, approvalId) : undefined;
    const suggestions = context.suppressAlwaysAllowRule ? undefined : context.suggestions?.map(update => ({ ...update, destination: "session" as const }));
    return new Promise((resolve) => {
      const deny = () => { if (this.approvals.delete(approvalId)) this.publish("approval.expired", { approvalId }); resolve({ behavior: "deny", message: "Approval interrupted." }); };
      context.signal.addEventListener("abort", deny, { once: true });
      this.approvals.set(approvalId, { input, suggestions, questions, resolve: (result) => { context.signal.removeEventListener("abort", deny); resolve(result); } });
      this.publish("approval.requested", { approvalId, method: questions ? "claude/question" : "claude/tool/requestApproval", prompt: questions ? questions.questions.map(q => q.question).join("\n") : `Allow Claude to use ${name}?`,
        choices: questions ? [{ value: "submit", label: "Submit answers" }, { value: "cancel", label: "Skip questions" }] : [{ value: "accept", label: "Allow once" }, ...(suggestions?.length ? [{ value: "acceptForSession", label: "Allow for session" }] : []), { value: "decline", label: "Deny" }],
        params: { tool: name, input }, ...(questions ? { userInput: questions } : {}) });
    });
  }
  async applyApprovalDecision(approvalId: string, decision: ApprovalDecisionRequest) {
    const pending = this.approvals.get(approvalId);
    if (!pending) throw new Error("Unknown Claude approval.");
    if (pending.questions) {
      if (decision.decision !== "submit" && decision.decision !== "cancel") throw new Error("Invalid Claude question decision.");
      const answers = decision.decision === "submit" ? claudeQuestionAnswers(pending.questions, decision.answers) : null;
      this.approvals.delete(approvalId);
      pending.resolve(answers ? { behavior: "allow", updatedInput: { ...pending.input, answers } } : { behavior: "deny", message: "User skipped the questions." });
      return { method: "claude/question", approvalId };
    }
    if (decision.decision === "acceptForSession" && !pending.suggestions?.length) throw new Error("Session approval is unavailable for this request.");
    if (!["accept", "acceptForSession", "decline", "cancel"].includes(decision.decision)) throw new Error("Invalid Claude approval decision.");
    this.approvals.delete(approvalId);
    pending.resolve(decision.decision === "accept" || decision.decision === "acceptForSession" ? { behavior: "allow", updatedInput: pending.input, ...(decision.decision === "acceptForSession" ? { updatedPermissions: pending.suggestions } : {}) } : { behavior: "deny", message: decision.reason ?? "Denied by user." });
    return { method: "claude/tool/requestApproval", approvalId };
  }
  async steerTurn(input: UserInput[], turnId?: string): Promise<string> {
    if (!this.input || !this.activeTurnId || (turnId && turnId !== this.activeTurnId)) throw new Error("No matching active Claude turn.");
    const message = this.userMessage(input);
    this.input.push(message); this.steeredMessages++;
    this.requireThread().turns.at(-1)!.items.push({ id: message.uuid!, type: "userMessage", content: input });
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
        this.publish("thread.status.changed", { status: { backgroundTaskCount: 0 } });
      }
    }
  }
  async readThread(id: string, includeTurns: boolean) { const thread = this.thread?.id === id ? this.thread : this.store.read(id); return { thread: this.record(thread, includeTurns) }; }
  private record(thread: ClaudeThread, includeTurns = false): P.ThreadRecord { return { id: thread.id, name: thread.name, preview: thread.preview, createdAt: thread.createdAt, updatedAt: thread.updatedAt, cwd: thread.cwd, modelProvider: "anthropic", source: "appServer", ...(includeTurns ? { turns: thread.turns } : {}) }; }
  async listStoredThreads(request: P.ListStoredThreadsRequest) {
    const threads = this.store.list().filter((t) => t.archived === (request.archived ?? false) && (!request.searchTerm || `${t.name ?? ""} ${t.preview}`.toLowerCase().includes(request.searchTerm.toLowerCase())) && (!request.cwd || (Array.isArray(request.cwd) ? request.cwd.includes(t.cwd) : request.cwd === t.cwd)) && (!request.modelProviders || request.modelProviders.includes("anthropic")) && (!request.sourceKinds || request.sourceKinds.includes("appServer")));
    const key = request.sortKey === "created_at" ? "createdAt" : "updatedAt";
    threads.sort((a, b) => (request.sortDirection === "asc" ? 1 : -1) * (a[key] - b[key]));
    return paginate(threads.map((t) => this.record(t)), request);
  }
  async listLoadedThreads(request: P.ListLoadedThreadsRequest) { return paginate(this.thread ? [this.thread.id] : [], request); }
  async listThreadTurns(id: string, request: P.ListThreadTurnsRequest) {
    const thread = this.thread?.id === id ? this.thread : this.store.read(id);
    const turns = [...thread.turns]; if (request.sortDirection !== "asc") turns.reverse();
    return paginate(turns.map((turn) => ({ ...turn, itemsView: request.itemsView ?? "full", items: request.itemsView === "notLoaded" ? [] : turn.items })), request);
  }
  async listThreadItems(id: string, request: P.ListThreadItemsRequest) {
    const thread = this.thread?.id === id ? this.thread : this.store.read(id);
    const items = thread.turns.filter((t) => !request.turnId || t.id === request.turnId).flatMap((t) => t.items.map((item) => ({ turnId: t.id, item })));
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
  async compactThread(_id: string): Promise<void> { throw new UnsupportedProviderOperationError("Claude", "manual compaction"); }
  async revertThread(_id: string, _before: string): Promise<P.RevertThreadResponse> { throw new UnsupportedProviderOperationError("Claude", "reverting turns"); }
  async listModels(request: P.ListModelsRequest): Promise<P.ListModelsResponse> {
    await this.initialize();
    const defaults = claudeDefaults();
    const running = this.openQuery(new InputQueue<SDKUserMessage>(), { cwd: this.thread?.cwd ?? process.cwd(), model: this.thread?.model ?? defaults.model, ...(claudeExecutablePath() ? { pathToClaudeCodeExecutable: claudeExecutablePath() } : {}), permissionMode: "dontAsk" });
    try {
      const models = await running.supportedModels();
      const catalog = claudeModelCatalog(models, defaults).filter(model => request.includeHidden || !model.hidden);
      const page = paginate(catalog, request);
      return { data: page.data, nextCursor: page.nextCursor };
    } finally { this.closeQuery(running); }
  }
  async listSkills(_request: P.SkillsListRequest): Promise<P.SkillsListResponse> { throw new UnsupportedProviderOperationError("Claude", "listing skills; Claude loads project skills through its settings"); }
  async writeSkillConfig(_request: P.SkillsConfigWriteRequest): Promise<P.SkillsConfigWriteResponse> { throw new UnsupportedProviderOperationError("Claude", "skill configuration"); }
  async readAccountRateLimits(): Promise<P.AccountRateLimitsResponse> { throw new UnsupportedProviderOperationError("Claude", "Codex account rate limits"); }
  async consumeRateLimitReset(_request: P.ConsumeRateLimitResetRequest): Promise<P.ConsumeRateLimitResetResponse> { throw new UnsupportedProviderOperationError("Claude", "Codex rate limit reset credits"); }
  stop(): void { this.stopped = true; this.interrupted = true; for (const running of this.ownedQueries.keys()) this.closeQuery(running); this.denyPendingApprovals(); this.finishTurn("interrupted"); this.backgroundTasks.reset(); }
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
  private persist() { const thread = this.requireThread(); thread.updatedAt = Date.now() / 1000; this.store.write(thread); }
  private publish(type: BridgeEventType, payload: unknown, id = this.requireThread().id) { this.eventBus.publish({ id: `${this.sessionId}:${++this.counter}`, type, payload, threadId: id, sessionId: this.sessionId, ts: new Date().toISOString() }); }
}
