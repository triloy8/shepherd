import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline, { type Interface as ReadlineInterface } from "node:readline";
import { randomUUID } from "node:crypto";

import type { ApprovalDecisionRequest, ApprovalRequestPayload } from "../../shared/protocol/approvals.js";
import type { BridgeEvent, BridgeEventType } from "../../shared/protocol/events.js";
import type {
  ApprovalPolicy,
  CreateThreadRequest,
  ForkThreadRequest,
  ListLoadedThreadsRequest,
  ListStoredThreadsRequest,
  ResumeThreadRequest,
  SkillsConfigWriteRequest,
  SkillsConfigWriteResponse,
  SkillsListRequest,
  SkillsListResponse,
  SkillsRemoteExportRequest,
  SkillsRemoteExportResponse,
  SkillsRemoteListRequest,
  SkillsRemoteListResponse,
  ThreadTokenUsage,
} from "../../shared/protocol/requests.js";
import { EventBus } from "./event_bus.js";
import {
  extractTextDelta,
  extractThreadId,
  extractTurnId,
  mapApprovalChoices,
  mapApprovalPrompt,
} from "./codex_rpc_mapper.js";

const DEFAULT_MODEL = process.env.CODEX_MODEL ?? "gpt-5.3-codex";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type RawServerRequest = {
  id: string | number;
  method: string;
  params: unknown;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function isContextLimitError(params: unknown): boolean {
  const record = asRecord(params);
  const errorInfo = record.codexErrorInfo;
  if (typeof errorInfo === "string") {
    return errorInfo.toLowerCase().includes("contextwindowexceeded");
  }
  if (errorInfo && typeof errorInfo === "object") {
    return "contextWindowExceeded" in (errorInfo as Record<string, unknown>);
  }
  const message = asString(record.message) ?? "";
  return message.toLowerCase().includes("context") && message.toLowerCase().includes("window");
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
  private approvalIdsByRawRequestId = new Map<string, string>();
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

    this.child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) {
        this.publish("session.error", this.threadId ?? "unbound", { message: text });
      }
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      await this.start();
      await this.sendRequest("initialize", {
        protocolVersion: 1,
        capabilities: {},
        clientInfo: { name: "agent-refactor", version: "1.0.0" },
      });
      this.sendNotification("initialized", {});
      this.initialized = true;
      this.publish("session.started", this.threadId ?? "unbound", { model: DEFAULT_MODEL });
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

  async startThread(request: CreateThreadRequest): Promise<string> {
    await this.initialize();
    this.approvalPolicy = request.approvalPolicy ?? this.approvalPolicy;
    const result = await this.sendRequest("thread/start", {
      model: request.model ?? DEFAULT_MODEL,
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

    const threadId = this.mustSetThreadIdFromResult(result, "thread/start");
    this.publish("thread.started", threadId, { approvalPolicy: this.approvalPolicy });
    return threadId;
  }

  async resumeThread(threadId: string, request: ResumeThreadRequest): Promise<string> {
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

    if (request.approvalPolicy) {
      this.approvalPolicy = request.approvalPolicy;
    }
    return this.mustSetThreadIdFromResult(result, "thread/resume");
  }

  async forkThread(threadId: string, request: ForkThreadRequest): Promise<string> {
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

    if (request.approvalPolicy) {
      this.approvalPolicy = request.approvalPolicy;
    }
    return this.mustSetThreadIdFromResult(result, "thread/fork");
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
      sortKey: request.sortKey ?? null,
      sourceKinds: request.sourceKinds ?? null,
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
    return this.sendRequest("account/rateLimits/read", {});
  }

  async listSkills(request: SkillsListRequest): Promise<SkillsListResponse> {
    await this.initialize();
    return this.sendRequest("skills/list", {
      ...(request.cwds ? { cwds: request.cwds } : {}),
      ...(request.forceReload !== undefined ? { forceReload: request.forceReload } : {}),
      ...(request.perCwdExtraUserRoots !== undefined ? { perCwdExtraUserRoots: request.perCwdExtraUserRoots } : {}),
    }) as Promise<SkillsListResponse>;
  }

  async listRemoteSkills(request: SkillsRemoteListRequest): Promise<SkillsRemoteListResponse> {
    await this.initialize();
    return this.sendRequest("skills/remote/list", {
      ...(request.enabled !== undefined ? { enabled: request.enabled } : {}),
      ...(request.hazelnutScope ? { hazelnutScope: request.hazelnutScope } : {}),
      ...(request.productSurface ? { productSurface: request.productSurface } : {}),
    }) as Promise<SkillsRemoteListResponse>;
  }

  async exportRemoteSkill(request: SkillsRemoteExportRequest): Promise<SkillsRemoteExportResponse> {
    await this.initialize();
    return this.sendRequest("skills/remote/export", {
      hazelnutId: request.hazelnutId,
    }) as Promise<SkillsRemoteExportResponse>;
  }

  async writeSkillConfig(request: SkillsConfigWriteRequest): Promise<SkillsConfigWriteResponse> {
    await this.initialize();
    return this.sendRequest("skills/config/write", {
      enabled: request.enabled,
      path: request.path,
    }) as Promise<SkillsConfigWriteResponse>;
  }

  async startTurn(input: string, approvalPolicy?: ApprovalPolicy): Promise<string | null> {
    const threadId = await this.ensureThread();
    if (approvalPolicy) {
      this.approvalPolicy = approvalPolicy;
    }

    const result = await this.sendRequest("turn/start", {
      threadId,
      approvalPolicy: this.approvalPolicy,
      input: [{ type: "text", text: input }],
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

  async steerTurn(input: string, turnId?: string): Promise<string | null> {
    const threadId = await this.ensureThread();
    const targetTurnId = turnId ?? this.activeTurnId;
    if (!targetTurnId) {
      throw new Error("No active turn to steer.");
    }

    const result = await this.sendRequest("turn/steer", {
      threadId,
      expectedTurnId: targetTurnId,
      input: [{ type: "text", text: input }],
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
    const payload = this.mapDecisionPayload(method, decision.decision);
    const envelope = {
      id: rawRequest.id,
      result: payload,
    };

    this.writeLine(envelope);
    this.serverRequestsByApprovalId.delete(approvalId);
    this.approvalIdsByRawRequestId.delete(String(rawRequest.id));
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

  private mapDecisionPayload(method: string, decision: string): Record<string, unknown> {
    if (method === "item/tool/call") {
      return {
        success: decision === "success",
        contentItems: [],
      };
    }

    if (method === "item/tool/requestUserInput") {
      return {
        answers: {},
      };
    }

    return { decision };
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
    this.approvalIdsByRawRequestId.clear();
    this.initialized = false;
    this.activeTurnId = null;
  }

  private async sendRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextRequestId++;
    this.writeLine({ id, method, params });

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
    });
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    this.writeLine({ method, params });
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

  private onServerRequest(request: RawServerRequest): void {
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
    this.approvalIdsByRawRequestId.set(String(request.id), approvalId);
    this.publish("approval.requested", threadId, approvalPayload);
  }

  private onNotification(method: string, params: unknown): void {
    const threadId = this.threadId ?? "unbound";
    const lower = method.toLowerCase();

    if (lower === "turn/completed") {
      const turnId = extractTurnId(params) ?? this.activeTurnId;
      this.activeTurnId = null;
      this.publish("turn.completed", threadId, { turnId });
      return;
    }

    if (lower.includes("turn/error") || lower.endsWith("/failed") || lower === "item/failed") {
      this.publish("turn.failed", threadId, { message: `${method} received` });
    }

    if (lower === "error") {
      const message = asString(asRecord(params).message) ?? `${method} received`;
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
      const payload = asRecord(params);
      const tokenUsage = payload.tokenUsage as ThreadTokenUsage | undefined;
      this.publish("thread.tokenUsage.updated", threadId, {
        turnId: asString(payload.turnId),
        tokenUsage: tokenUsage ?? null,
      });
      return;
    }

    const delta = extractTextDelta(method, params);
    if (delta) {
      this.publish("turn.stream.delta", threadId, { method, textDelta: delta });
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
}
