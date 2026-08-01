import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline, { type Interface as ReadlineInterface } from "node:readline";
import { randomUUID } from "node:crypto";

import type { ApprovalDecisionRequest, ApprovalRequestPayload } from "../../shared/protocol/approvals.js";
import type { BridgeEvent, BridgeEventType, MessagePhase } from "../../shared/protocol/events.js";
import type {
  ApprovalPolicy,
  CreateThreadRequest,
  ForkThreadRequest,
  ListLoadedThreadsRequest,
  ListModelsRequest,
  ListModelsResponse,
  ListStoredThreadsRequest,
  ResumeThreadRequest,
  SkillsConfigWriteRequest,
  SkillsConfigWriteResponse,
  SkillsListRequest,
  SkillsListResponse,
  ThreadTokenUsage,
} from "../../shared/protocol/requests.js";
import type { UserInput } from "../../shared/protocol/user_input.js";
import { EventBus } from "./event_bus.js";
import {
  extractCompletedAgentMessage,
  extractGeneratedImageArtifact,
  extractItemId,
  extractTextDelta,
  extractThreadId,
  extractTurnId,
  mapTurnActivity,
  mapApprovalChoices,
  mapApprovalPrompt,
} from "./codex_rpc_mapper.js";

function getDefaultModel(): string {
  return process.env.CODEX_MODEL ?? "gpt-5.3-codex";
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
  "thread/rollback": { threadId: string; numTurns: number };
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
  "thread/read": { threadId: string; includeTurns: boolean };
  "account/rateLimits/read": undefined;
  "model/list": { cursor: string | null; limit: number | null; includeHidden: boolean | null };
  "skills/list": { cwds?: string[]; forceReload?: boolean };
  "skills/config/write": { enabled: boolean; path: string };
  "turn/start": {
    threadId: string;
    approvalPolicy: ApprovalPolicy;
    input: UserInput[];
    model?: string;
    cwd?: string;
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

type ThreadBootstrapInfo = {
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

export class CodexSession {
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

  constructor(approvalPolicy: ApprovalPolicy) {
    this.approvalPolicy = approvalPolicy;
  }

  async start(): Promise<void> {
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
      this.cleanup();
    });

    this.child.stderr.on("data", (chunk: Buffer) => this.onServerStderr(chunk));
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      await this.start();
      await this.sendRequest("initialize", {
        capabilities: {},
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
    const result = await this.sendRequest("thread/start", {
      model: request.model ?? getDefaultModel(),
      approvalPolicy: this.approvalPolicy,
      ...(request.baseInstructions ? { baseInstructions: request.baseInstructions } : {}),
      ...(request.developerInstructions ? { developerInstructions: request.developerInstructions } : {}),
      ...(request.config ? { config: request.config } : {}),
      ...(request.cwd ? { cwd: request.cwd } : {}),
      ...(request.personality ? { personality: request.personality } : {}),
      ...(request.sandbox ? { sandbox: request.sandbox } : {}),
      ...(request.modelProvider ? { modelProvider: request.modelProvider } : {}),
      ...(request.ephemeral !== undefined ? { ephemeral: request.ephemeral } : {}),
      ...(request.serviceName ? { serviceName: request.serviceName } : {}),
    });

    const bootstrap = this.extractThreadBootstrapInfo(result, "thread/start");
    this.approvalPolicy = bootstrap.approvalPolicy;
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

  async rollbackThread(threadId: string, numTurns: number): Promise<unknown> {
    await this.initialize();
    return this.sendRequest("thread/rollback", { threadId, numTurns });
  }

  async listStoredThreads(request: ListStoredThreadsRequest): Promise<unknown> {
    await this.initialize();
    return this.sendRequest("thread/list", {
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
    });
  }

  async listLoadedThreads(request: ListLoadedThreadsRequest): Promise<unknown> {
    await this.initialize();
    return this.sendRequest("thread/loaded/list", {
      cursor: request.cursor ?? null,
      limit: request.limit ?? null,
    });
  }

  async readThread(threadId: string, includeTurns: boolean): Promise<unknown> {
    await this.initialize();
    return this.sendRequest("thread/read", { threadId, includeTurns });
  }

  async readAccountRateLimits(): Promise<unknown> {
    await this.initialize();
    return this.sendRequest("account/rateLimits/read", undefined);
  }

  async listModels(request: ListModelsRequest): Promise<ListModelsResponse> {
    await this.initialize();
    return this.sendRequest("model/list", {
      cursor: request.cursor ?? null,
      limit: request.limit ?? null,
      includeHidden: request.includeHidden ?? null,
    }) as Promise<ListModelsResponse>;
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
    });

    const turnId = extractTurnId(result);
    this.activeTurnId = turnId;
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
    const payload = this.mapDecisionPayload(method, decision);
    const envelope = {
      id: rawRequest.id,
      result: payload,
    };

    this.writeLine(envelope);
    this.serverRequestsByApprovalId.delete(approvalId);
    return { method, approvalId };
  }

  stop(): void {
    this.cleanup();
  }

  private mustSetThreadIdFromResult(result: unknown, method: string): string {
    const threadId = extractThreadId(result);
    if (!threadId) {
      throw new Error(`${method} returned an invalid thread id.`);
    }
    this.threadId = threadId;
    return threadId;
  }

  private extractThreadBootstrapInfo(result: unknown, method: string): ThreadBootstrapInfo {
    const threadId = this.mustSetThreadIdFromResult(result, method);
    const record = asRecord(result);
    const thread = asRecord(record.thread);
    return {
      threadId,
      model: asString(record.model),
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
    this.serverRequestsByApprovalId.clear();
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
    this.publish("approval.requested", threadId, approvalPayload);
  }

  private onNotification(method: string, params: unknown): void {
    const payload = asRecord(params);
    const threadId = asString(payload.threadId) ?? this.threadId ?? "unbound";
    const lower = method.toLowerCase();

    if (lower === "turn/completed") {
      const turnId = extractTurnId(params) ?? this.activeTurnId;
      this.activeTurnId = null;
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
