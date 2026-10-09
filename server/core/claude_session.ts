import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { query, forkSession, createSdkMcpServer, type Options, type Query, type SDKMessage, type SDKUserMessage, type PermissionResult, type CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type * as P from "../../shared/protocol/requests.js";
import type { ApprovalDecisionRequest } from "../../shared/protocol/approvals.js";
import type { BridgeEventType } from "../../shared/protocol/events.js";
import type { DynamicToolSpec, JsonValue } from "../../shared/protocol/dynamic_tools.js";
import type { UserInput } from "../../shared/protocol/user_input.js";
import { UnsupportedProviderOperationError, type AgentSession, type ThreadBootstrapInfo } from "./agent_session.js";
import { DynamicToolRegistry } from "./dynamic_tool_registry.js";
import { claudeExecutablePath } from "./claude_executable.js";
import { EventBus } from "./event_bus.js";

type ClaudeThread = {
  id: string; nativeId: string; materialized: boolean; cwd: string; model: string;
  effort: Options["effort"]; name: string | null; preview: string; archived: boolean;
  createdAt: number; updatedAt: number; instructions: string;
  turns: P.HistoryTurn[];
  tokenUsage?: P.ThreadTokenUsage;
};

/** Shepherd metadata complements the SDK's persisted conversation transcript. */
export class ClaudeThreadStore {
  constructor(private readonly directory = process.env.SHEPHERD_CLAUDE_STATE_DIR ?? join(homedir(), ".shepherd", "claude")) {}
  read(id: string): ClaudeThread {
    if (!/^claude-[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid Claude thread id.");
    const value = JSON.parse(readFileSync(join(this.directory, `${id}.json`), "utf8")) as ClaudeThread;
    if (value.id !== id) throw new Error("Invalid Claude thread metadata.");
    return value;
  }
  write(thread: ClaudeThread): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const file = join(this.directory, `${thread.id}.json`);
    const temporary = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(thread), { mode: 0o600 });
    renameSync(temporary, file);
  }
  list(): ClaudeThread[] {
    let files: string[];
    try { files = readdirSync(this.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    return files.filter((file) => /^claude-[0-9a-f-]{36}\.json$/.test(file)).map((file) => this.read(file.slice(0, -5)));
  }
}

class InputQueue implements AsyncIterable<SDKUserMessage> {
  private messages: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private ended = false;
  push(message: SDKUserMessage) { if (this.ended) throw new Error("Turn input is closed."); this.messages.push(message); this.wake?.(); }
  close() { this.ended = true; this.wake?.(); }
  async *[Symbol.asyncIterator]() {
    while (!this.ended || this.messages.length) {
      const message = this.messages.shift();
      if (message) yield message;
      else await new Promise<void>((resolve) => { this.wake = resolve; });
    }
  }
}

function paginate<T>(values: T[], request: { cursor?: string; limit?: number }) {
  const offset = request.cursor ? Number(request.cursor) : 0;
  const limit = request.limit ?? 20;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid Claude pagination.");
  return { data: values.slice(offset, offset + limit), nextCursor: offset + limit < values.length ? String(offset + limit) : null, backwardsCursor: null };
}

export class ClaudeSession implements AgentSession {
  readonly sessionId = randomUUID();
  readonly eventBus = new EventBus();
  activeTurnId: string | null = null;
  private thread: ClaudeThread | null = null;
  private running: Query | null = null;
  private input: InputQueue | null = null;
  private stopped = false;
  private counter = 0;
  private interrupted = false;
  private approvals = new Map<string, { resolve: (result: PermissionResult) => void; input: Record<string, unknown>; suggestions: Parameters<CanUseTool>[2]["suggestions"] }>();
  constructor(
    public approvalPolicy: P.ApprovalPolicy = "on-request",
    private readonly dynamicTools = new DynamicToolRegistry(),
    private readonly store = new ClaudeThreadStore(),
    private readonly sdk = { query, forkSession },
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
    this.thread = { id: `claude-${nativeId}`, nativeId, materialized: false, cwd: request.cwd ?? process.cwd(), model: request.model ?? process.env.CLAUDE_MODEL ?? "sonnet", effort: "high", name: null, preview: "", archived: false, createdAt: Date.now() / 1000, updatedAt: Date.now() / 1000, instructions: [request.baseInstructions, request.developerInstructions].filter(Boolean).join("\n\n"), turns: [] };
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
    await this.resumeThread(id, request);
    const source = this.requireThread();
    const nativeId = source.materialized ? (await this.sdk.forkSession(source.nativeId, { dir: source.cwd })).sessionId : randomUUID();
    this.thread = { ...source, id: `claude-${nativeId}`, nativeId, name: null, archived: false, createdAt: Date.now() / 1000, turns: structuredClone(source.turns) };
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
    if (this.activeTurnId || this.running) throw new Error("A Claude turn is already active.");
    const thread = this.requireThread();
    if (typeof policy === "object") throw new UnsupportedProviderOperationError("Claude", "granular approval policies");
    if (effort && !["low", "medium", "high", "xhigh", "max"].includes(effort)) throw new Error("Unsupported Claude effort.");
    const message = this.userMessage(input);
    this.approvalPolicy = policy ?? this.approvalPolicy;
    const options: Options = {
      cwd: cwd ?? thread.cwd, model: model ?? thread.model, effort: (effort as Options["effort"]) ?? thread.effort,
      ...(thread.materialized ? { resume: thread.nativeId } : { sessionId: thread.nativeId }),
      ...(claudeExecutablePath() ? { pathToClaudeCodeExecutable: claudeExecutablePath() } : {}),
      includePartialMessages: true, settingSources: ["user", "project", "local"],
      systemPrompt: { type: "preset", preset: "claude_code", append: thread.instructions || undefined },
      permissionMode: this.approvalPolicy === "never" ? "bypassPermissions" : "default",
      ...(this.approvalPolicy === "never" ? { allowDangerouslySkipPermissions: true } : { canUseTool: (name: string, args: Record<string, unknown>, context: Parameters<CanUseTool>[2]) => this.requestApproval(name, args, context) }),
      mcpServers: this.mcpServers(),
    };
    const queue = new InputQueue(); queue.push(message);
    const running = this.sdk.query({ prompt: queue, options });
    thread.cwd = options.cwd!; thread.model = options.model!; thread.effort = options.effort;
    const turn: P.HistoryTurn = { id: randomUUID(), status: "inProgress", itemsView: "full", items: [{ id: message.uuid!, type: "userMessage", content: input }], error: null, startedAt: Date.now() / 1000, completedAt: null, durationMs: null };
    thread.turns.push(turn); thread.preview ||= input.filter((part) => part.type === "text").map((part) => part.text).join("\n").slice(0, 200);
    this.input = queue; this.running = running; this.activeTurnId = turn.id; this.interrupted = false;
    try { this.persist(); }
    catch (error) {
      running.close(); queue.close(); thread.turns.pop();
      this.input = null; this.running = null; this.activeTurnId = null;
      throw error;
    }
    this.publish("turn.started", { turnId: turn.id });
    void this.consume(running, queue, turn);
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
  private async consume(running: Query, queue: InputQueue, turn: P.HistoryTurn) {
    let streamItemId: string | null = null;
    try {
      let result = false;
      for await (const message of running) {
        if (this.stopped) break;
        if (message.type === "system" && message.subtype === "init") {
          this.requireThread().nativeId = message.session_id; this.requireThread().materialized = true; this.persist();
        }
        if (message.type === "stream_event" && !message.parent_tool_use_id) {
          if (message.event.type === "message_start") streamItemId = message.event.message.id;
          if (message.event.type === "content_block_delta" && message.event.delta.type === "text_delta") this.publish("turn.stream.delta", { method: "item/agentMessage/delta", textDelta: message.event.delta.text, itemId: streamItemId, turnId: turn.id, phase: null });
        }
        if (message.type === "assistant" && !message.parent_tool_use_id) this.assistantMessage(message, turn);
        if (message.type === "user" && Array.isArray(message.message.content)) {
          for (const block of message.message.content) if (block.type === "tool_result") {
            const item = turn.items.find((item) => item.id === block.tool_use_id);
            if (item) {
              item.status = block.is_error ? "failed" : "completed";
              item.result = block.content;
              this.publish("turn.activity", { itemId: item.id, turnId: turn.id, kind: "mcp_tool", label: String(item.tool), detail: null, status: item.status });
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
          this.publish("thread.tokenUsage.updated", { turnId: turn.id, tokenUsage: { last, total } });
          result = true;
          if (message.is_error) throw new Error(message.subtype === "success" ? message.result : message.errors.join("\n"));
          if ((message.queued_turn_count ?? 0) === 0) break;
        }
      }
      if (!result && !this.interrupted && !this.stopped) throw new Error("Claude stream ended before a turn result.");
      turn.status = this.interrupted || this.stopped ? "interrupted" : "completed";
    } catch (error) {
      turn.status = this.interrupted || this.stopped ? "interrupted" : "failed";
      if (turn.status === "failed") turn.error = { message: error instanceof Error ? error.message : String(error) };
    } finally {
      queue.close(); running.close(); this.denyPendingApprovals();
      this.running = null; this.input = null; this.activeTurnId = null;
      turn.completedAt = Date.now() / 1000; turn.durationMs = (turn.completedAt - turn.startedAt!) * 1000;
      try { this.persist(); } catch (error) { turn.status = "failed"; turn.error = { message: String(error) }; }
      if (!this.stopped) this.publish(turn.status === "failed" ? "turn.failed" : "turn.completed", { turnId: turn.id, ...(turn.error ? { message: turn.error.message } : {}) });
    }
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
      const item = { id: block.id, type: "mcpToolCall", server: "claude", tool: block.name, arguments: block.input };
      turn.items.push(item);
      this.publish("turn.activity", { itemId: block.id, turnId: turn.id, kind: block.name === "Bash" ? "command" : ["Edit", "Write"].includes(block.name) ? "file_change" : "mcp_tool", label: block.name, detail: JSON.stringify(block.input), status: "started" });
    }
    this.persist();
  }
  private mcpServers(): NonNullable<Options["mcpServers"]> {
    if (!this.dynamicTools.hasTools()) return {};
    const server = createSdkMcpServer({ name: "shepherd", version: "1.0.0" });
    server.instance.server.registerCapabilities({ tools: {} });
    const specs = this.dynamicTools.specifications().flatMap<Extract<DynamicToolSpec, { type: "function" }> & { namespace: string | null; wireName: string }>((spec) => spec.type === "namespace" ? spec.tools.map((tool) => ({ ...tool, namespace: spec.name, wireName: `${spec.name}__${tool.name}` })) : [{ ...spec, namespace: null, wireName: spec.name }]);
    if (new Set(specs.map((spec) => spec.wireName)).size !== specs.length) throw new Error("Claude MCP tool names collide.");
    server.instance.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: specs.map((spec) => ({ name: spec.wireName, description: spec.description, inputSchema: spec.inputSchema as { type: "object" } })) }));
    server.instance.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const spec = specs.find((spec) => spec.wireName === request.params.name);
      if (!spec || !this.activeTurnId) throw new Error("Unknown or inactive Shepherd tool call.");
      const result = await this.dynamicTools.execute({ threadId: this.requireThread().id, turnId: this.activeTurnId, callId: randomUUID(), namespace: spec.namespace, tool: spec.name, arguments: (request.params.arguments ?? {}) as JsonValue });
      return { isError: !result.success, content: result.contentItems.map((item) => item.type === "inputText" ? { type: "text", text: item.text } : { type: "text", text: JSON.stringify(item) }) };
    });
    return { shepherd: server };
  }
  private requestApproval(name: string, input: Record<string, unknown>, context: Parameters<CanUseTool>[2]): Promise<PermissionResult> {
    if (this.approvalPolicy === "never" || context.signal.aborted || this.stopped) return Promise.resolve({ behavior: "deny", message: "Tool requires approval." });
    const approvalId = randomUUID();
    return new Promise((resolve) => {
      const deny = () => { if (this.approvals.delete(approvalId)) this.publish("approval.failed", { approvalId, message: "Approval interrupted." }); resolve({ behavior: "deny", message: "Approval interrupted." }); };
      context.signal.addEventListener("abort", deny, { once: true });
      this.approvals.set(approvalId, { input, suggestions: context.suggestions, resolve: (result) => { context.signal.removeEventListener("abort", deny); resolve(result); } });
      this.publish("approval.requested", { approvalId, method: "claude/tool/requestApproval", prompt: `Allow Claude to use ${name}?`, choices: [{ value: "accept", label: "Allow once" }, { value: "acceptForSession", label: "Allow for session" }, { value: "decline", label: "Deny" }], params: { tool: name, input } });
    });
  }
  async applyApprovalDecision(approvalId: string, decision: ApprovalDecisionRequest) {
    const pending = this.approvals.get(approvalId);
    if (!pending) throw new Error("Unknown Claude approval.");
    if (!["accept", "acceptForSession", "decline", "cancel"].includes(decision.decision)) throw new Error("Invalid Claude approval decision.");
    this.approvals.delete(approvalId);
    pending.resolve(decision.decision === "accept" || decision.decision === "acceptForSession" ? { behavior: "allow", updatedInput: pending.input, ...(decision.decision === "acceptForSession" ? { updatedPermissions: pending.suggestions } : {}) } : { behavior: "deny", message: decision.reason ?? "Denied by user." });
    return { method: "claude/tool/requestApproval", approvalId };
  }
  async steerTurn(input: UserInput[], turnId?: string): Promise<string> {
    if (!this.input || !this.activeTurnId || (turnId && turnId !== this.activeTurnId)) throw new Error("No matching active Claude turn.");
    const message = this.userMessage(input);
    this.input.push(message);
    this.requireThread().turns.at(-1)!.items.push({ id: message.uuid!, type: "userMessage", content: input });
    this.persist(); return this.activeTurnId;
  }
  async interruptTurn(turnId?: string): Promise<void> {
    if (!this.running || !this.activeTurnId || (turnId && turnId !== this.activeTurnId)) throw new Error("No matching active Claude turn.");
    this.interrupted = true; this.denyPendingApprovals(); this.input?.close(); await this.running.interrupt();
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
  async setThreadName(id: string, name: string) { const thread = this.store.read(id); thread.name = name; this.saveMutation(thread); this.publish("thread.name.updated", { threadName: name }, id); }
  async archiveThread(id: string) { const thread = this.store.read(id); thread.archived = true; this.saveMutation(thread); this.publish("thread.archived", {}, id); }
  async unarchiveThread(id: string) { const thread = this.store.read(id); thread.archived = false; this.saveMutation(thread); this.publish("thread.unarchived", {}, id); }
  setCwd(cwd: string): void { this.requireThread().cwd = cwd; this.persist(); }
  private saveMutation(thread: ClaudeThread) { if (this.thread?.id === thread.id) Object.assign(this.thread, thread); thread.updatedAt = Date.now() / 1000; this.store.write(thread); }
  async compactThread(_id: string): Promise<void> { throw new UnsupportedProviderOperationError("Claude", "manual compaction"); }
  async revertThread(_id: string, _before: string): Promise<unknown> { throw new UnsupportedProviderOperationError("Claude", "reverting turns"); }
  async listModels(request: P.ListModelsRequest): Promise<P.ListModelsResponse> {
    const running = this.sdk.query({ prompt: new InputQueue(), options: { cwd: this.thread?.cwd ?? process.cwd(), model: this.thread?.model ?? "sonnet", ...(claudeExecutablePath() ? { pathToClaudeCodeExecutable: claudeExecutablePath() } : {}), permissionMode: "dontAsk" } });
    try {
      const models = await running.supportedModels();
      const page = paginate(models.map((m) => ({ id: m.value, model: m.value, displayName: m.displayName, description: m.description, hidden: false, isDefault: m.value === "sonnet", supportsPersonality: false, defaultReasoningEffort: m.supportsEffort ? "high" : null, supportedReasoningEfforts: (m.supportedEffortLevels ?? []).map((e) => ({ reasoningEffort: e, description: "" })) })), request);
      return { data: page.data, nextCursor: page.nextCursor };
    } finally { running.close(); }
  }
  async listSkills(_request: P.SkillsListRequest): Promise<P.SkillsListResponse> { throw new UnsupportedProviderOperationError("Claude", "listing skills; Claude loads project skills through its settings"); }
  async writeSkillConfig(_request: P.SkillsConfigWriteRequest): Promise<P.SkillsConfigWriteResponse> { throw new UnsupportedProviderOperationError("Claude", "skill configuration"); }
  async readAccountRateLimits(): Promise<unknown> { throw new UnsupportedProviderOperationError("Claude", "Codex account rate limits"); }
  async consumeRateLimitReset(_request: P.ConsumeRateLimitResetRequest): Promise<unknown> { throw new UnsupportedProviderOperationError("Claude", "Codex rate limit reset credits"); }
  stop(): void { this.stopped = true; this.interrupted = true; this.input?.close(); this.running?.close(); this.denyPendingApprovals(); this.activeTurnId = null; }
  private denyPendingApprovals() { for (const [approvalId, pending] of this.approvals) { pending.resolve({ behavior: "deny", message: "Turn ended." }); this.publish("approval.failed", { approvalId, message: "Turn ended." }); } this.approvals.clear(); }
  private requireThread(): ClaudeThread { if (!this.thread) throw new Error("Claude thread is not bound."); return this.thread; }
  private persist() { const thread = this.requireThread(); thread.updatedAt = Date.now() / 1000; this.store.write(thread); }
  private publish(type: BridgeEventType, payload: unknown, id = this.requireThread().id) { this.eventBus.publish({ id: `${this.sessionId}:${++this.counter}`, type, payload, threadId: id, sessionId: this.sessionId, ts: new Date().toISOString() }); }
}
