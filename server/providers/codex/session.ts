import { readResponse, revertResponse, storedResponse, loadedResponse, accountResponse, modelsResponse } from "./responses.js";
import { NativeConversationSource } from "../neutral_source.js";
import { publicItemId } from "../neutral_items.js";
import { codexInteraction } from "./neutral_interactions.js";
type SandboxPolicy = { type: "dangerFullAccess" } | { type: "readOnly"; networkAccess: boolean } | { type: "workspaceWrite"; writableRoots: string[]; networkAccess: boolean; excludeTmpdirEnvVar: boolean; excludeSlashTmp: boolean };
import { NeutralInteractions } from "../neutral_interactions.js";
import { configured, modelCatalog, nativeInput } from "../neutral_controls.js";
import type { ApprovalMode, ThreadSettings } from "../../../shared/protocol/v2/conversations.js";
import { CodexNeutralMapper } from "./neutral_mapper.js";
import { decodeResetOutcome } from "./account_usage.js";
import { codexCapabilities } from "../capabilities.js";
import { parseUserQuestionRequest, validateUserQuestionAnswers } from "../../../shared/protocol/user_questions.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline, { type Interface as ReadlineInterface } from "node:readline";
import { randomUUID } from "node:crypto";

import type { ApprovalDecisionRequest, ApprovalRequestPayload } from "../../../shared/protocol/approvals.js";
import type {
  DynamicToolCallParams,
  DynamicToolSpec,
  JsonValue,
} from "../../../shared/protocol/dynamic_tools.js";
import type { BridgeEvent, BridgeEventType, MessagePhase } from "../../../shared/protocol/events.js";
import type {
  ConsumeRateLimitResetRequest,
  ApprovalPolicy,
  CreateThreadRequest,
  ForkThreadRequest,
  ListLoadedThreadsRequest,
  ListModelsRequest,
  ListThreadTurnsRequest,
  ListThreadTurnsResponse,
  ListThreadItemsRequest,
  ListThreadItemsResponse,
  ListModelsResponse,
  ListStoredThreadsRequest,
  ResumeThreadRequest,
  SkillsConfigWriteRequest,
  SkillsConfigWriteResponse,
  SkillsListRequest,
  SkillsListResponse,
  ThreadTokenUsage,
} from "../../../shared/protocol/requests.js";
import type { UserInput } from "../../../shared/protocol/user_input.js";
import {
  DynamicToolRegistry,
  InvalidDynamicToolCallError,
  UnknownDynamicToolError,
} from "../../core/dynamic_tool_registry.js";
import type { AgentSession } from "../../core/agent_session.js";
import { EventBus } from "../../core/event_bus.js";
import {
  extractCompletedAgentMessage,
  extractGeneratedImageArtifact,
  extractViewedImageArtifact,
  extractItemId,
  extractTextDelta,
  extractThreadId,
  extractTurnId,
  mapTurnActivity,
  mapApprovalChoices,
  mapApprovalPrompt,
} from "./rpc_mapper.js";

function getDefaultModel(): string {
  return process.env.CODEX_MODEL ?? "gpt-6.1-sol";
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type RawServerRequest = {
  id: string | number;
  method: string;
  params: unknown;
};

type AppServerRequestParams = {
  initialize: {
    capabilities: Record<string, unknown> | null;
    clientInfo: { name: string; title: string | null; version: string };
  };
  "thread/start": {
    model: string;
    approvalPolicy: ApprovalPolicy;
    baseInstructions?: string;
    developerInstructions?: string;
    config?: Record<string, unknown>;
    cwd?: string;
    personality?: string;
    sandbox?: string;
    modelProvider?: string;
    ephemeral?: boolean;
    serviceName?: string;
    dynamicTools?: DynamicToolSpec[];
  };
  "thread/resume": {
    threadId: string;
    approvalPolicy?: ApprovalPolicy;
    baseInstructions?: string;
    developerInstructions?: string;
    config?: Record<string, unknown>;
    cwd?: string;
    personality?: string;
    sandbox?: string;
    model?: string;
    modelProvider?: string;
  };
  "thread/fork": {
    threadId: string;
    approvalPolicy?: ApprovalPolicy;
    baseInstructions?: string;
    developerInstructions?: string;
    config?: Record<string, unknown>;
    cwd?: string;
    sandbox?: string;
    model?: string;
    modelProvider?: string;
  };
  "thread/archive": { threadId: string };
  "thread/unarchive": { threadId: string };
  "thread/name/set": { threadId: string; name: string };
  "thread/compact/start": { threadId: string };
  "thread/revert": { threadId: string; beforeTurnId: string };
  "thread/list": {
    archived: boolean | null;
    cursor: string | null;
    cwd: string | string[] | null;
    limit: number | null;
    modelProviders: string[] | null;
    searchTerm: string | null;
    sortDirection: "asc" | "desc" | null;
    sortKey: "created_at" | "updated_at" | "recency_at" | null;
    sourceKinds: string[] | null;
    useStateDbOnly?: boolean;
  };
  "thread/loaded/list": { cursor: string | null; limit: number | null };
  "thread/turns/list": ListThreadTurnsRequest & { threadId: string };
  "thread/items/list": ListThreadItemsRequest & { threadId: string };
  "thread/read": { threadId: string; includeTurns: boolean };
  "account/rateLimits/read": undefined;
  "account/rateLimitResetCredit/consume": ConsumeRateLimitResetRequest;
  "model/list": { cursor: string | null; limit: number | null; includeHidden: boolean | null };
  "skills/list": { cwds?: string[]; forceReload?: boolean };
  "skills/config/write": { enabled: boolean; path: string };
  "turn/start": {
    threadId: string;
    approvalPolicy: ApprovalPolicy;
    input: UserInput[];
    model?: string;
    effort?: string;
    cwd?: string;
    sandboxPolicy?: SandboxPolicy;
  };
  "turn/interrupt": { threadId: string; turnId: string };
  "turn/steer": { threadId: string; expectedTurnId: string; input: UserInput[] };
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 50) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every((item) => isJsonValue(item, depth + 1));
}

function parseDynamicToolCallParams(value: unknown): DynamicToolCallParams {
  const record = asRecord(value);
  const threadId = asString(record.threadId);
  const turnId = asString(record.turnId);
  const callId = asString(record.callId);
  const tool = asString(record.tool);
  const namespace = record.namespace === null ? null : asString(record.namespace);
  if (!threadId || !turnId || !callId || !tool || (record.namespace !== null && !namespace)) {
    throw new InvalidDynamicToolCallError("Dynamic tool call has invalid identity fields.");
  }
  if (!Object.hasOwn(record, "arguments") || !isJsonValue(record.arguments)) {
    throw new InvalidDynamicToolCallError("Dynamic tool call arguments must be valid JSON.");
  }
  return {
    threadId,
    turnId,
    callId,
    namespace,
    tool,
    arguments: record.arguments,
  };
}

type ThreadBootstrapInfo = {
  reasoningEffort: string | null;
  threadId: string;
  model: string | null;
  modelProvider: string | null;
  approvalPolicy: ApprovalPolicy;
};

function isContextLimitError(params: unknown): boolean {
  const error = asRecord(asRecord(params).error);
  const errorInfo = error.codexErrorInfo;
  if (typeof errorInfo === "string") {
    return errorInfo.toLowerCase().includes("contextwindowexceeded");
  }
  if (errorInfo && typeof errorInfo === "object") {
    return "contextWindowExceeded" in (errorInfo as Record<string, unknown>);
  }
  const message = asString(error.message) ?? "";
  return message.toLowerCase().includes("context") && message.toLowerCase().includes("window");
}

function asApprovalPolicy(value: unknown): ApprovalPolicy | null {
  if (value === "untrusted" || value === "on-request" || value === "never") {
    return value;
  }
  const record = asRecord(value);
  const granular = asRecord(record.granular);
  if (
    typeof granular.sandbox_approval === "boolean" &&
    typeof granular.rules === "boolean" &&
    typeof granular.skill_approval === "boolean" &&
    typeof granular.request_permissions === "boolean" &&
    typeof granular.mcp_elicitations === "boolean"
  ) {
    return {
      granular: {
        sandbox_approval: granular.sandbox_approval,
        rules: granular.rules,
        skill_approval: granular.skill_approval,
        request_permissions: granular.request_permissions,
        mcp_elicitations: granular.mcp_elicitations,
      },
    };
  }
  return null;
}

function isApprovalServerRequest(method: string): boolean {
  const normalized = method.toLowerCase();
  return (
    normalized === "item/commandexecution/requestapproval" ||
    normalized === "item/filechange/requestapproval" ||
    normalized === "execcommandapproval" ||
    normalized === "applypatchapproval"
  );
}

export class CodexSession implements AgentSession {
  readonly neutral: NativeConversationSource = new NativeConversationSource({ fork: false, steering: true, compact: false, revert: false,
    skills: { list: false, configure: false }, resets: false, questions: true, backgroundWork: false,
    inputKinds: ["text", "asset"], inputMedia: ["image"],
    approvalModes: ["provider_default", "review_sensitive", "bypass"], sandboxModes: ["read_only", "workspace_write", "unrestricted"] },
    async (threadId, cursor) => {
      let page;
      try { page = await this.listThreadItems(threadId, { cursor, limit: 3, sortDirection: "asc" }); }
      catch (error) {
        if (!cursor && error instanceof Error && error.message === `thread ${threadId} is not materialized yet; thread/items/list is unavailable before first user message`) return { data: [], nextCursor: null };
        throw error;
      }
      const ids = new Set(page.data.map(entry => entry.turnId));
      const states = new Map<string, "in_progress" | "completed" | "failed" | "interrupted">();
      let turnCursor: string | undefined;
      const seen = new Set<string>();
      do {
        const turns = await this.listThreadTurns(threadId, { cursor: turnCursor, limit: 100, itemsView: "notLoaded", sortDirection: "asc" });
        for (const turn of turns.data) if (ids.has(turn.id)) states.set(turn.id, turn.status === "inProgress" ? "in_progress" : turn.status);
        if (states.size === ids.size || !turns.nextCursor) break;
        if (seen.has(turns.nextCursor)) throw new Error("Repeated native turn cursor.");
        seen.add(turns.nextCursor); turnCursor = turns.nextCursor;
      } while (true);
      // Terminal turn metadata must precede the authoritative item read. A completion
      // between the first two reads cannot turn an older text prefix into a full answer.
      if ([...states.values()].some(state => state !== "in_progress")) page = await this.listThreadItems(threadId, { cursor, limit: 3, sortDirection: "asc" });
      return { data: page.data.map(entry => ({ turnId: entry.turnId, item: this.neutralMapper.item(threadId, entry.turnId, entry.item, states.get(entry.turnId)) })), nextCursor: page.nextCursor };
    });
  private readonly neutralMapper: CodexNeutralMapper = new CodexNeutralMapper(this.neutral);
  readonly capabilities = codexCapabilities;
  readonly sessionId = randomUUID();
  readonly createdAt = new Date().toISOString();

  threadId: string | null = null;
  activeTurnId: string | null = null;
  approvalPolicy: ApprovalPolicy;
  readonly eventBus = new EventBus();

  private child: ChildProcessWithoutNullStreams | null = null;
  private lineReader: ReadlineInterface | null = null;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private nextRequestId = 1;
  private pendingRequests = new Map<number, PendingRequest>();
  private serverRequestsByApprovalId = new Map<string, RawServerRequest>();
  private messagePhaseByItemId = new Map<string, MessagePhase | null>();
  private eventCounter = 0;

  constructor(
    approvalPolicy: ApprovalPolicy,
    private readonly dynamicTools: DynamicToolRegistry = new DynamicToolRegistry(),
  ) {
    this.approvalPolicy = approvalPolicy;
    this.defaultApprovalPolicy = approvalPolicy;
    this.neutral.controls = {
      skills: {
        list: async reload => {
          const result = await this.listSkills({ cwds: [this.neutralSettings.cwd], forceReload: reload });
          this.neutralSkillPaths.clear();
          const all = result.data.flatMap(entry => entry.skills);
          const skills = all.slice(0, 100).map(skill => {
            const referenceId = publicItemId(this.threadId ?? this.sessionId, skill.path);
            this.neutralSkillPaths.set(referenceId, skill.path);
            return { referenceId, name: skill.name.slice(0, 256), description: skill.description.slice(0, 4096), enabled: skill.enabled };
          });
          return { skills, warnings: result.data.flatMap(entry => entry.errors.map(error => error.message.slice(0, 4096))).slice(0, 100), omitted: Math.max(0, all.length - skills.length) };
        },
        configure: async (referenceId, enabled) => {
          const path = this.neutralSkillPaths.get(referenceId);
          if (!path) throw new Error("Skill reference expired. Reload skills.");
          return { enabled: (await this.writeSkillConfig({ path, enabled })).effectiveEnabled };
        },
      },
      settings: () => structuredClone(this.neutralSettings),
      configure: async patch => this.neutralSettings = await configured(this.neutralSettings, patch, this.neutral.controls!.models),
      models: modelCatalog(cursor => this.listModels({ cursor, limit: 100 })),
      context: async () => this.neutralUsage,
      submit: async turn => {
        const settings = this.neutralSettings;
        const id = await this.startTurn(await nativeInput(this.neutral, turn.input), this.nativePolicy(turn.approvalMode ?? settings.approvalMode), turn.model ?? settings.model ?? undefined, turn.cwd ?? settings.cwd, turn.effort ?? settings.effort ?? undefined, settings.sandboxMode === "unrestricted" ? { type: "dangerFullAccess" } : settings.sandboxMode === "read_only" ? { type: "readOnly", networkAccess: false } : { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false });
        if (!id) throw new Error("Provider did not return a turn identity.");
        return id;
      },
      steer: async (input, turnId) => {
        const id = await this.steerTurn(await nativeInput(this.neutral, input), turnId);
        if (!id) throw new Error("Provider did not return a turn identity.");
        return id;
      },
      interrupt: turnId => this.interruptTurn(turnId),
      respond: (id, reply) => this.neutralInteractions.respond(id, reply),
    };
  }

  setCwd(cwd: string): void {
    if (this.activeTurnId) throw new Error("Wait for work to finish before changing the working directory.");
    this.neutralSettings = { ...this.neutralSettings, cwd };
  }

  private readonly neutralSkillPaths = new Map<string, string>();
  private neutralSettings: ThreadSettings = { cwd: process.cwd(), model: null, effort: null, approvalMode: "provider_default", sandboxMode: "workspace_write" };
  private neutralUsage: import("../../../shared/protocol/v2/conversations.js").TokenUsage | null = null;
  private readonly neutralInteractions = new NeutralInteractions(this.neutral, this.sessionId);
  private defaultApprovalPolicy: ApprovalPolicy;
  private nativePolicy(mode: ApprovalMode): ApprovalPolicy { return mode === "bypass" ? "never" : mode === "review_sensitive" ? "on-request" : this.defaultApprovalPolicy; }
  private stopped = false;

  async start(): Promise<void> {
    if (this.stopped) throw new Error("Codex session is stopped.");
    if (this.child) return;

    this.child = spawn("codex", ["app-server"], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    this.lineReader = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.lineReader.on("line", (line) => this.onServerLine(line));

    this.child.on("error", (error) => {
      this.publish("session.error", "unbound", { message: `Failed to spawn codex app-server: ${error.message}` });
    });

    this.child.on("exit", (code, signal) => {
      const message = `codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`;
      this.publish("session.error", this.threadId ?? "unbound", { message });
      if (!this.stopped) this.neutralMapper.disconnected(this.threadId);
      this.cleanup();
    });

    this.child.stderr.on("data", (chunk: Buffer) => this.onServerStderr(chunk));
  }

  async initialize(): Promise<void> {
    if (this.stopped) throw new Error("Codex session is stopped.");
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      await this.start();
      await this.sendRequest("initialize", {
        capabilities: { experimentalApi: true },
        clientInfo: { name: "shepherd", title: "Shepherd", version: "1.0.0" },
      });
      this.sendNotification("initialized");
      this.initialized = true;
      this.publish("session.started", this.threadId ?? "unbound", { model: getDefaultModel() });
    })();

    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  async ensureThread(): Promise<string> {
    if (this.threadId) return this.threadId;
    throw new Error("No active thread bound to this session.");
  }

  async startThread(request: CreateThreadRequest): Promise<ThreadBootstrapInfo> {
    await this.initialize();
    this.approvalPolicy = request.approvalPolicy ?? this.approvalPolicy;
    const dynamicTools = this.dynamicTools.specifications();
    const result = await this.sendRequest("thread/start", {
      model: request.model ?? getDefaultModel(),
      approvalPolicy: this.approvalPolicy,
      ...(request.baseInstructions ? { baseInstructions: request.baseInstructions } : {}),
      ...(request.developerInstructions ? { developerInstructions: request.developerInstructions } : {}),
      config: { model_reasoning_effort: "medium", ...request.config },
      ...(request.cwd ? { cwd: request.cwd } : {}),
      ...(request.personality ? { personality: request.personality } : {}),
      ...(request.sandbox ? { sandbox: request.sandbox } : {}),
      ...(request.modelProvider ? { modelProvider: request.modelProvider } : {}),
      ...(request.ephemeral !== undefined ? { ephemeral: request.ephemeral } : {}),
      ...(request.serviceName ? { serviceName: request.serviceName } : {}),
      ...(dynamicTools.length > 0 ? { dynamicTools } : {}),
    });

    const bootstrap = this.extractThreadBootstrapInfo(result, "thread/start");
    this.approvalPolicy = bootstrap.approvalPolicy;
    this.neutralSettings = { ...this.neutralSettings, cwd: request.cwd ?? asString(asRecord(asRecord(result).thread).cwd) ?? this.neutralSettings.cwd, model: bootstrap.model, effort: bootstrap.reasoningEffort };
    this.publish("thread.started", bootstrap.threadId, { approvalPolicy: this.approvalPolicy });
    return bootstrap;
  }

  async resumeThread(threadId: string, request: ResumeThreadRequest): Promise<ThreadBootstrapInfo> {
    await this.initialize();
    const result = await this.sendRequest("thread/resume", {
      threadId,
      ...(request.approvalPolicy ? { approvalPolicy: request.approvalPolicy } : {}),
      ...(request.baseInstructions ? { baseInstructions: request.baseInstructions } : {}),
      ...(request.developerInstructions ? { developerInstructions: request.developerInstructions } : {}),
      ...(request.config ? { config: request.config } : {}),
      ...(request.cwd ? { cwd: request.cwd } : {}),
      ...(request.personality ? { personality: request.personality } : {}),
      ...(request.sandbox ? { sandbox: request.sandbox } : {}),
      ...(request.model ? { model: request.model } : {}),
      ...(request.modelProvider ? { modelProvider: request.modelProvider } : {}),
    });

    const bootstrap = this.extractThreadBootstrapInfo(result, "thread/resume");
    this.approvalPolicy = bootstrap.approvalPolicy;
    this.neutralSettings = { ...this.neutralSettings, cwd: request.cwd ?? asString(asRecord(asRecord(result).thread).cwd) ?? this.neutralSettings.cwd, model: bootstrap.model, effort: bootstrap.reasoningEffort };
    return bootstrap;
  }

  async forkThread(threadId: string, request: ForkThreadRequest): Promise<ThreadBootstrapInfo> {
    await this.initialize();
    const result = await this.sendRequest("thread/fork", {
      threadId,
      ...(request.approvalPolicy ? { approvalPolicy: request.approvalPolicy } : {}),
      ...(request.baseInstructions ? { baseInstructions: request.baseInstructions } : {}),
      ...(request.developerInstructions ? { developerInstructions: request.developerInstructions } : {}),
      ...(request.config ? { config: request.config } : {}),
      ...(request.cwd ? { cwd: request.cwd } : {}),
      ...(request.sandbox ? { sandbox: request.sandbox } : {}),
      ...(request.model ? { model: request.model } : {}),
      ...(request.modelProvider ? { modelProvider: request.modelProvider } : {}),
    });

    const bootstrap = this.extractThreadBootstrapInfo(result, "thread/fork");
    this.approvalPolicy = bootstrap.approvalPolicy;
    this.neutralSettings = { ...this.neutralSettings, cwd: request.cwd ?? asString(asRecord(asRecord(result).thread).cwd) ?? this.neutralSettings.cwd, model: bootstrap.model, effort: bootstrap.reasoningEffort };
    return bootstrap;
  }

  async archiveThread(threadId: string): Promise<void> {
    await this.initialize();
    await this.sendRequest("thread/archive", { threadId });
  }

  async unarchiveThread(threadId: string): Promise<void> {
    await this.initialize();
    await this.sendRequest("thread/unarchive", { threadId });
  }

  async setThreadName(threadId: string, name: string): Promise<void> {
    await this.initialize();
    await this.sendRequest("thread/name/set", { threadId, name });
  }

  async compactThread(threadId: string): Promise<void> {
    await this.initialize();
    await this.sendRequest("thread/compact/start", { threadId });
  }

  async revertThread(threadId: string, beforeTurnId: string) {
    await this.initialize();
    return revertResponse(await this.sendRequest("thread/revert", { threadId, beforeTurnId }));
  }

  async listStoredThreads(request: ListStoredThreadsRequest) {
    await this.initialize();
    return storedResponse(await this.sendRequest("thread/list", {
      archived: request.archived ?? null,
      cursor: request.cursor ?? null,
      cwd: request.cwd ?? null,
      limit: request.limit ?? null,
      modelProviders: request.modelProviders ?? null,
      searchTerm: request.searchTerm ?? null,
      sortDirection: request.sortDirection ?? null,
      sortKey: request.sortKey ?? null,
      sourceKinds: request.sourceKinds ?? null,
      ...(request.useStateDbOnly !== undefined ? { useStateDbOnly: request.useStateDbOnly } : {}),
    }));
  }

  async listLoadedThreads(request: ListLoadedThreadsRequest) {
    await this.initialize();
    return loadedResponse(await this.sendRequest("thread/loaded/list", {
      cursor: request.cursor ?? null,
      limit: request.limit ?? null,
    }));
  }

  async listThreadTurns(threadId: string, request: ListThreadTurnsRequest): Promise<ListThreadTurnsResponse> {
    await this.initialize();
    try {
      return await this.sendRequest("thread/turns/list", { ...request, threadId }) as ListThreadTurnsResponse;
    } catch (error) {
      // Codex does not persist a newly created thread until its first user message.
      // Only this explicit first-page condition means empty history; never hide
      // missing threads, bad cursors, transport failures or other backend errors.
      if (!request.cursor && error instanceof Error && error.message ===
        `thread ${threadId} is not materialized yet; thread/turns/list is unavailable before first user message`) {
        return { data: [], nextCursor: null, backwardsCursor: null };
      }
      throw error;
    }
  }

  async listThreadItems(threadId: string, request: ListThreadItemsRequest): Promise<ListThreadItemsResponse> {
    await this.initialize();
    return this.sendRequest("thread/items/list", { ...request, threadId }) as Promise<ListThreadItemsResponse>;
  }

  async readThread(threadId: string, includeTurns: boolean) {
    await this.initialize();
    return readResponse(await this.sendRequest("thread/read", { threadId, includeTurns }));
  }

  async consumeRateLimitReset(request: ConsumeRateLimitResetRequest) {
    await this.initialize();
    return decodeResetOutcome(await this.sendRequest("account/rateLimitResetCredit/consume", request));
  }

  async readAccountRateLimits() {
    await this.initialize();
    return accountResponse(await this.sendRequest("account/rateLimits/read", undefined));
  }

  async listModels(request: ListModelsRequest) {
    await this.initialize();
    return modelsResponse(await this.sendRequest("model/list", {
      cursor: request.cursor ?? null,
      limit: request.limit ?? null,
      includeHidden: request.includeHidden ?? null,
    }));
  }

  async listSkills(request: SkillsListRequest): Promise<SkillsListResponse> {
    await this.initialize();
    return this.sendRequest("skills/list", {
      ...(request.cwds ? { cwds: request.cwds } : {}),
      ...(request.forceReload !== undefined ? { forceReload: request.forceReload } : {}),
    }) as Promise<SkillsListResponse>;
  }

  async writeSkillConfig(request: SkillsConfigWriteRequest): Promise<SkillsConfigWriteResponse> {
    await this.initialize();
    return this.sendRequest("skills/config/write", {
      enabled: request.enabled,
      path: request.path,
    }) as Promise<SkillsConfigWriteResponse>;
  }

  async startTurn(
    input: UserInput[],
    approvalPolicy?: ApprovalPolicy,
    model?: string,
    cwd?: string,
    effort?: string,
    sandboxPolicy?: SandboxPolicy,
  ): Promise<string | null> {
    const threadId = await this.ensureThread();
    if (approvalPolicy) {
      this.approvalPolicy = approvalPolicy;
    }
    this.messagePhaseByItemId.clear();

    const result = await this.sendRequest("turn/start", {
      threadId,
      approvalPolicy: this.approvalPolicy,
      input,
      ...(model ? { model } : {}),
      ...(cwd ? { cwd } : {}),
      ...(effort ? { effort } : {}),
      ...(sandboxPolicy ? { sandboxPolicy } : {}),
    });

    const turnId = extractTurnId(result);
    this.activeTurnId = turnId;
    if (turnId) this.neutralMapper.turnStarted(turnId);
    this.publish("turn.started", threadId, { turnId });
    return turnId;
  }

  async interruptTurn(turnId?: string): Promise<void> {
    const threadId = await this.ensureThread();
    const targetTurnId = turnId ?? this.activeTurnId;
    if (!targetTurnId) {
      throw new Error("No active turn to interrupt.");
    }
    await this.sendRequest("turn/interrupt", { threadId, turnId: targetTurnId });
  }

  async steerTurn(input: UserInput[], turnId?: string): Promise<string | null> {
    const threadId = await this.ensureThread();
    const targetTurnId = turnId ?? this.activeTurnId;
    if (!targetTurnId) {
      throw new Error("No active turn to steer.");
    }

    const result = await this.sendRequest("turn/steer", {
      threadId,
      expectedTurnId: targetTurnId,
      input,
    });
    const returnedTurnId = extractTurnId(result) ?? targetTurnId;
    this.activeTurnId = returnedTurnId;
    return returnedTurnId;
  }

  async applyApprovalDecision(
    approvalId: string,
    decision: ApprovalDecisionRequest,
  ): Promise<{ method: string; approvalId: string }> {
    const rawRequest = this.serverRequestsByApprovalId.get(approvalId);
    if (!rawRequest) {
      throw new Error(`Unknown approval id: ${approvalId}`);
    }

    const method = rawRequest.method;
    let payload: unknown;
    if (method === "item/tool/requestUserInput") {
      const input = parseUserQuestionRequest(rawRequest.params);
      if (decision.decision === "submit") {
        validateUserQuestionAnswers(input.questions, decision.answers);
        payload = { answers: decision.answers };
      } else if (decision.decision === "cancel") payload = { answers: {} };
      else throw new Error("Invalid user input decision.");
    } else payload = this.mapDecisionPayload(method, decision);
    const envelope = {
      id: rawRequest.id,
      result: payload,
    };

    this.writeLine(envelope);
    this.serverRequestsByApprovalId.delete(approvalId);
    this.neutralInteractions.external(approvalId, decision.decision === "submit" ? "submit" : ["accept", "acceptForSession", "approved", "approved_for_session"].includes(decision.decision) ? "allow" : "deny");
    return { method, approvalId };
  }

  stop(): void {
    this.stopped = true;
    this.cleanup();
    this.neutralInteractions.expire();
    this.neutral.close();
  }

  private mustSetThreadIdFromResult(result: unknown, method: string): string {
    const threadId = extractThreadId(result);
    if (!threadId) {
      throw new Error(`${method} returned an invalid thread id.`);
    }
    this.threadId = threadId;
    this.neutral.bind(threadId);
    return threadId;
  }

  private extractThreadBootstrapInfo(result: unknown, method: string): ThreadBootstrapInfo {
    const threadId = this.mustSetThreadIdFromResult(result, method);
    const record = asRecord(result);
    const thread = asRecord(record.thread);
    return {
      threadId,
      model: asString(record.model),
      reasoningEffort: asString(record.reasoningEffort),
      modelProvider: asString(record.modelProvider) ?? asString(thread.modelProvider),
      approvalPolicy: asApprovalPolicy(record.approvalPolicy) ?? this.approvalPolicy,
    };
  }

  private mapDecisionPayload(
    method: string,
    request: ApprovalDecisionRequest,
  ): Record<string, unknown> {
    const normalized = method.toLowerCase();
    const decision = request.decision;

    if (
      normalized === "item/commandexecution/requestapproval" ||
      normalized === "item/filechange/requestapproval"
    ) {
      if (!["accept", "acceptForSession", "decline", "cancel"].includes(decision)) {
        throw new Error(`Invalid decision ${decision} for ${method}.`);
      }
      return { decision };
    }

    if (normalized === "execcommandapproval" || normalized === "applypatchapproval") {
      if (decision === "denied") {
        return { decision: { denied: { rejection: request.reason ?? "Denied by user." } } };
      }
      if (!["approved", "approved_for_session", "timed_out", "abort"].includes(decision)) {
        throw new Error(`Invalid decision ${decision} for ${method}.`);
      }
      return { decision };
    }

    throw new Error(`Unsupported server request method: ${method}`);
  }

  private cleanup(): void {
    this.lineReader?.close();
    this.lineReader = null;

    if (this.child && !this.child.killed) {
      this.child.kill("SIGTERM");
    }
    this.child = null;

    for (const pending of this.pendingRequests.values()) {
      pending.reject(new Error("Session terminated."));
    }
    this.pendingRequests.clear();
    for (const [approvalId, request] of this.serverRequestsByApprovalId) {
      if (request.method === "item/tool/requestUserInput") this.publish("approval.expired", asString(asRecord(request.params).threadId) ?? "unbound", { approvalId });
    }
    this.serverRequestsByApprovalId.clear();
    this.neutralInteractions.expire();
    this.initialized = false;
    this.activeTurnId = null;
  }

  private async sendRequest<M extends keyof AppServerRequestParams>(
    method: M,
    params: AppServerRequestParams[M],
  ): Promise<unknown> {
    const id = this.nextRequestId++;
    this.writeLine({ id, method, params });

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
    });
  }

  private sendNotification(method: "initialized"): void {
    this.writeLine({ method });
  }

  private writeLine(payload: unknown): void {
    if (!this.child?.stdin) {
      throw new Error("codex app-server is not running.");
    }
    const line = `${JSON.stringify(payload)}\n`;
    this.child.stdin.write(line, "utf8");
  }

  private onServerLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      this.publish("session.error", this.threadId ?? "unbound", { message: "Invalid JSON from app-server." });
      return;
    }

    const record = asRecord(message);
    const id = record.id;
    const method = record.method;

    if ((typeof id === "number" || typeof id === "string") && typeof method === "string") {
      this.onServerRequest({ id, method, params: record.params ?? {} });
      return;
    }

    if (typeof id === "number") {
      const pending = this.pendingRequests.get(id);
      if (!pending) return;
      this.pendingRequests.delete(id);
      if (record.error) {
        const error = asRecord(record.error);
        pending.reject(new Error((error.message as string) ?? "App-server request failed."));
      } else {
        pending.resolve(record.result);
      }
      return;
    }

    if (typeof method === "string") {
      this.onNotification(method, record.params ?? {});
    }
  }

  private onServerStderr(chunk: Buffer): void {
    const text = chunk.toString("utf8").trim();
    if (text) console.error(`codex app-server stderr: ${text}`);
  }

  private onServerRequest(request: RawServerRequest): void {
    if (request.method.toLowerCase() === "item/tool/call") {
      this.handleDynamicToolCall(request);
      return;
    }

    if (request.method === "item/tool/requestUserInput") {
      try {
        const userInput = parseUserQuestionRequest(request.params);
        if (userInput.threadId !== this.threadId || userInput.turnId !== this.activeTurnId) throw new Error("User question targets a stale turn or the wrong thread.");
        const approvalId = randomUUID();
        this.serverRequestsByApprovalId.set(approvalId, request);
        try { this.registerNeutralInteraction(approvalId, request, userInput); }
        catch (error) { this.serverRequestsByApprovalId.delete(approvalId); throw error; }
        this.publish("approval.requested", userInput.threadId, {
          approvalId, method: request.method, prompt: userInput.questions.map(q => q.question).join("\n\n"),
          choices: [{ value: "submit", label: "Submit answers" }, { value: "cancel", label: "Skip questions" }],
          params: request.params, userInput,
        } satisfies ApprovalRequestPayload);
      } catch (error) {
        this.writeLine({ id: request.id, error: { code: -32602, message: (error as Error).message } });
      }
      return;
    }

    if (!isApprovalServerRequest(request.method)) {
      this.writeLine({
        id: request.id,
        error: {
          code: -32601,
          message: `Shepherd does not support server request ${request.method}.`,
        },
      });
      this.publish("session.error", this.threadId ?? "unbound", {
        message: `Unsupported app-server request: ${request.method}`,
      });
      return;
    }

    const approvalId = randomUUID();
    const threadId = this.threadId ?? "unbound";
    const approvalPayload: ApprovalRequestPayload = {
      approvalId,
      method: request.method,
      prompt: mapApprovalPrompt(request.method, request.params),
      choices: mapApprovalChoices(request.method),
      params: request.params,
    };

    this.serverRequestsByApprovalId.set(approvalId, request);
    try { this.registerNeutralInteraction(approvalId, request); }
    catch { this.serverRequestsByApprovalId.delete(approvalId); this.writeLine({ id: request.id, result: { decision: request.method.includes("/") ? "cancel" : "abort" } }); this.neutral.warn(); return; }
    this.publish("approval.requested", threadId, approvalPayload);
  }

  private registerNeutralInteraction(id: string, request: RawServerRequest, questions?: import("../../../shared/protocol/user_questions.js").UserQuestionRequest): void {
    const params = asRecord(request.params), threadId = asString(params.threadId) ?? asString(params.conversationId) ?? this.threadId;
    const turnId = asString(params.turnId) ?? this.activeTurnId;
    if (!threadId || threadId !== this.threadId || (turnId !== null && this.neutralMapper.hasEndedTurn(turnId)) || (this.activeTurnId && turnId !== this.activeTurnId)) throw new Error("Interaction targets an unavailable turn.");
    const projected = codexInteraction(id, threadId, turnId, request.method, request.params, questions, async result => {
      if (this.serverRequestsByApprovalId.get(id) !== request) throw new Error("Native interaction expired.");
      this.writeLine({ id: request.id, result }); this.serverRequestsByApprovalId.delete(id);
      this.publish("approval.applied", threadId, { approvalId: id });
    });
    this.neutralInteractions.request(projected.request, projected.options);
  }
  private handleDynamicToolCall(request: RawServerRequest): void {
    void (async () => {
      try {
        if (!this.dynamicTools.hasTools()) {
          throw new UnknownDynamicToolError("Shepherd has no dynamic tools registered.");
        }
        const params = parseDynamicToolCallParams(request.params);
        if (params.threadId !== this.threadId) {
          throw new InvalidDynamicToolCallError("Dynamic tool call targets the wrong thread.");
        }
        if (params.turnId !== this.activeTurnId) {
          throw new InvalidDynamicToolCallError("Dynamic tool call targets a stale turn.");
        }
        const result = await this.dynamicTools.execute(params);
        this.writeLine({ id: request.id, result });
      } catch (error) {
        if (error instanceof InvalidDynamicToolCallError) {
          this.writeLine({
            id: request.id,
            error: { code: -32602, message: error.message },
          });
          return;
        }
        if (error instanceof UnknownDynamicToolError) {
          this.writeLine({
            id: request.id,
            error: { code: -32601, message: error.message },
          });
          return;
        }

        const message = error instanceof Error ? error.message : "Dynamic tool execution failed.";
        this.writeLine({
          id: request.id,
          result: {
            success: false,
            contentItems: [{ type: "inputText", text: message }],
          },
        });
        this.publish("session.error", this.threadId ?? "unbound", { message });
      }
    })();
  }

  private onNotification(method: string, params: unknown): void {
    this.neutralMapper.notification(method, params, this.threadId, this.activeTurnId);
    const payload = asRecord(params);
    const threadId = asString(payload.threadId) ?? this.threadId ?? "unbound";
    const lower = method.toLowerCase();

    if (lower === "serverrequest/resolved") {
      for (const [approvalId, request] of this.serverRequestsByApprovalId) {
        if (request.method === "item/tool/requestUserInput" && request.id === payload.requestId && asRecord(request.params).threadId === threadId) {
          this.serverRequestsByApprovalId.delete(approvalId);
          this.neutralInteractions.expire(approvalId);
          this.publish("approval.expired", threadId, { approvalId });
        }
      }
      return;
    }

    if (lower === "turn/completed") {
      const turnId = extractTurnId(params) ?? this.activeTurnId;
      this.activeTurnId = null;
      if (turnId) this.neutralInteractions.expire(undefined, turnId);
      for (const [id, request] of this.serverRequestsByApprovalId) {
        if (request.method === "item/tool/requestUserInput" && asRecord(request.params).turnId === turnId) this.serverRequestsByApprovalId.delete(id);
      }
      this.messagePhaseByItemId.clear();
      const turn = asRecord(payload.turn);
      if (turn.status === "failed") {
        const error = asRecord(turn.error);
        this.publish("turn.failed", threadId, {
          message: asString(error.message) ?? "The turn failed before completion.",
          turnId,
        });
        return;
      }
      this.publish("turn.completed", threadId, { turnId });
      return;
    }

    if (lower.includes("turn/error") || lower.endsWith("/failed") || lower === "item/failed") {
      this.messagePhaseByItemId.clear();
      this.publish("turn.failed", threadId, {
        message: `${method} received`,
        turnId: extractTurnId(params) ?? this.activeTurnId,
      });
      return;
    }

    if (lower === "error") {
      const error = asRecord(payload.error);
      const message = asString(error.message) ?? `${method} received`;
      if (payload.willRetry === true) {
        console.warn(`codex app-server retrying: ${message}`);
        return;
      }
      if (isContextLimitError(params)) {
        this.publish("session.limit.context", threadId, { message, method });
      } else {
        this.publish("session.error", threadId, { message });
      }
      return;
    }

    if (lower === "account/ratelimits/updated") {
      this.publish("turn.notification", threadId, { method, params });
      return;
    }

    if (lower === "thread/reverted") {
      this.publish("thread.reverted", threadId, {});
      return;
    }

    if (lower === "thread/status/changed") {
      this.publish("thread.status.changed", threadId, { status: asRecord(params).status ?? null });
      return;
    }

    if (lower === "thread/name/updated") {
      this.publish("thread.name.updated", threadId, {
        threadName: asString(asRecord(params).threadName),
      });
      return;
    }

    if (lower === "thread/archived") {
      this.publish("thread.archived", threadId, {});
      return;
    }

    if (lower === "thread/unarchived") {
      this.publish("thread.unarchived", threadId, {});
      return;
    }

    if (lower === "thread/tokenusage/updated") {
      const tokenUsage = payload.tokenUsage as ThreadTokenUsage | undefined;
      if (tokenUsage) this.neutralUsage = { ...tokenUsage, modelContextWindow: tokenUsage.modelContextWindow ?? null };
      this.publish("thread.tokenUsage.updated", threadId, {
        turnId: asString(payload.turnId),
        tokenUsage: tokenUsage ?? null,
      });
      return;
    }

    if (lower === "item/started" || lower === "item/completed") {
      this.captureAgentMessagePhase(params);
      if (lower === "item/completed") {
        const message = extractCompletedAgentMessage(params);
        if (message) {
          this.publish("turn.message.completed", threadId, message);
          return;
        }
        const generatedImage = extractGeneratedImageArtifact(params);
        if (generatedImage) {
          this.publish("turn.image.generated", threadId, generatedImage);
        }
        const viewedImage = extractViewedImageArtifact(params);
        if (viewedImage) {
          this.publish("turn.image.viewed", threadId, viewedImage);
        }
      }

      const activity = mapTurnActivity(params, lower === "item/started" ? "started" : "completed");
      if (activity) {
        this.publish("turn.activity", threadId, activity);
      }
      this.publish("turn.notification", threadId, { method, params });
      return;
    }

    const delta = extractTextDelta(method, params);
    if (delta) {
      const itemId = extractItemId(params);
      const phase = itemId ? (this.messagePhaseByItemId.get(itemId) ?? null) : null;
      this.publish("turn.stream.delta", threadId, {
        kind: method === "item/agentMessage/delta" ? "assistant_text" : "other",
        method,
        textDelta: delta,
        itemId,
        phase,
        turnId: extractTurnId(params) ?? this.activeTurnId,
      });
      return;
    }

    this.publish("turn.notification", threadId, { method, params });
  }

  private publish(type: BridgeEventType, threadId: string, payload: unknown): void {
    const event: BridgeEvent = {
      id: `${this.sessionId}:${++this.eventCounter}`,
      type,
      threadId,
      sessionId: this.sessionId,
      ts: new Date().toISOString(),
      payload,
    };
    this.eventBus.publish(event);
  }

  private captureAgentMessagePhase(params: unknown): void {
    const payload = asRecord(params);
    const item = asRecord(payload.item);
    const itemType = asString(item.type)?.replace(/[_\s]/g, "").toLowerCase();
    if (itemType !== "agentmessage") {
      return;
    }

    const itemId = asString(item.id);
    if (!itemId) {
      return;
    }

    this.messagePhaseByItemId.set(itemId, this.parseMessagePhase(item.phase));
  }

  private parseMessagePhase(value: unknown): MessagePhase | null {
    if (value === "commentary" || value === "final_answer") {
      return value;
    }
    return null;
  }
}
