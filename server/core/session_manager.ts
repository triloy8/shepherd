import { listProviderThreads, threadSummary } from "./provider_thread_catalog.js";
import { ConversationProjection } from "./conversation_projection.js";
import { ProjectionRecoveryError, type ProjectionCursor } from "./projection_event_log.js";
import { ApplicationActionError } from "./action_error.js";
import type {
  ApprovalDecisionRequest,
  ApprovalRecord,
  ApprovalRequestPayload,
} from "../../shared/protocol/approvals.js";
import type { ThreadTokenUsageUpdatedEvent } from "../../shared/protocol/events.js";
import type {
  ConsumeRateLimitResetRequest,
  ConsumeRateLimitResetResponse,
  ApprovalPolicy,
  AgentProvider,
  AccountRateLimitsResponse,
  ArchiveThreadResponse,
  CompactThreadResponse,
  CreateThreadRequest,
  CreateThreadResponse,
  ForkThreadRequest,
  ForkThreadResponse,
  GetThreadStateResponse,
  ListLoadedThreadsRequest,
  ListLoadedThreadsResponse,
  ListModelsRequest,
  ListThreadTurnsRequest,
  ListThreadTurnsResponse,
  ListThreadItemsRequest,
  ListThreadItemsResponse,
  ListModelsResponse,
  ListStoredThreadsRequest,
  ListStoredThreadsResponse,
  ListThreadsResponse,
  ThreadModelState,
  ThreadEffortState,
  ReadThreadRequest,
  ReadThreadResponse,
  ReadThreadTokenUsageResponse,
  ResumeThreadRequest,
  ResumeThreadResponse,
  RevertThreadRequest,
  RevertThreadResponse,
  SetThreadNameRequest,
  SkillsConfigWriteRequest,
  SkillsConfigWriteResponse,
  SkillsListRequest,
  SkillsListResponse,
  SteerTurnRequest,
  SteerTurnResponse,
  SubmitTurnRequest,
  SubmitTurnResponse,
  ThreadTokenUsage,
  UnarchiveThreadResponse,
} from "../../shared/protocol/requests.js";
import { ApprovalsStore } from "./approvals.js";
import { UnsupportedProviderOperationError, type AgentSession } from "./agent_session.js";
import { missingSessionFactory, memoryProviderDirectory, type ThreadProviderDirectory, type AgentSessionFactory } from "./agent_provider.js";
import { DynamicToolRegistry } from "./dynamic_tool_registry.js";

interface ManagedSession {
  session: AgentSession;
  createdAt: string;
  projection?: ConversationProjection;
}

export type RuntimeActivity = {
  activeTurnThreadIds: string[];
  pendingApprovalIds: string[];
};

type ManagedModelState = {
  currentModel: string | null;
  modelProvider: string | null;
  pendingModel: string | null;
};

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export const extractThreadSummary = threadSummary;

export class SessionManager {
  private sessionsByThread = new Map<string, ManagedSession>();
  private approvals = new ApprovalsStore();
  private tokenUsageByThread = new Map<string, ThreadTokenUsage>();
  private cwdByThread = new Map<string, string>();
  private effortStateByThread = new Map<string, { current: string | null; pending: string | null }>();
  private modelStateByThread = new Map<string, ManagedModelState>();
  private controlSessions = new Map<AgentProvider, AgentSession>();
  private controlSessionStarting = new Map<AgentProvider, Promise<AgentSession>>();
  private readonly ownedSessions = new Set<AgentSession>();
  private readonly sessionSubscriptions = new Map<AgentSession, () => void>();
  private readonly resuming = new Map<string, Promise<ResumeThreadResponse>>();
  private stopped = false;

  constructor(
    private readonly dynamicTools: DynamicToolRegistry = new DynamicToolRegistry(),
    private readonly sessionFactory: AgentSessionFactory = missingSessionFactory,
    private readonly providerHasStoredThreads = (_provider: AgentProvider, _request: ListStoredThreadsRequest) => false,
    private readonly providerDirectory: ThreadProviderDirectory = memoryProviderDirectory(),
    private readonly providers: readonly AgentProvider[] = ["codex", "claude"],
  ) {}

  async createThread(request: CreateThreadRequest): Promise<CreateThreadResponse> {
    return this.bootstrap(request, (session) => session.startThread(request));
  }

  async resumeThread(threadId: string, request: ResumeThreadRequest): Promise<ResumeThreadResponse> {
    this.assertRunning();
    this.threadProvider(threadId, request.provider);
    const existing = this.sessionsByThread.get(threadId);
    if (existing) return { threadId, sessionId: existing.session.sessionId };
    const pending = this.resuming.get(threadId);
    if (pending) return pending;
    const operation = this.bootstrap({ ...request, provider: this.threadProvider(threadId, request.provider) }, (session) => session.resumeThread(threadId, request));
    this.resuming.set(threadId, operation);
    try { return await operation; }
    finally { this.resuming.delete(threadId); }
  }

  async forkThread(threadId: string, request: ForkThreadRequest): Promise<ForkThreadResponse> {
    return this.bootstrap({ ...request, provider: this.threadProvider(threadId, request.provider) }, (session) => session.forkThread(threadId, request));
  }

  private async bootstrap(
    request: { approvalPolicy?: ApprovalPolicy; cwd?: string; provider?: AgentProvider },
    start: (session: AgentSession) => ReturnType<AgentSession["startThread"]>,
  ): Promise<CreateThreadResponse> {
    const session = this.allocateSession(request.approvalPolicy ?? "on-request", request.provider ?? "codex");
    try {
      const created = await start(session);
      this.assertRunning();
      this.providerDirectory.bind(created.threadId, request.provider ?? "codex");
      this.sessionsByThread.set(created.threadId, { session, createdAt: new Date().toISOString(),
        ...(session.neutral ? { projection: new ConversationProjection(created.threadId, session.sessionId, session.neutral) } : {}) });
      if (request.cwd) this.cwdByThread.set(created.threadId, request.cwd);
      this.effortStateByThread.set(created.threadId, { current: created.reasoningEffort, pending: null });
      this.modelStateByThread.set(created.threadId, {
        currentModel: created.model, modelProvider: created.modelProvider, pendingModel: null,
      });
      return { threadId: created.threadId, sessionId: session.sessionId };
    } catch (error) {
      this.releaseSession(session);
      throw error;
    }
  }

  listThreads(): ListThreadsResponse {
    return {
      threads: [...this.sessionsByThread.entries()].map(([threadId, managed]) => ({
        threadId,
        sessionId: managed.session.sessionId,
        createdAt: managed.createdAt,
      })),
    };
  }

  getRuntimeActivity(): RuntimeActivity {
    return {
      activeTurnThreadIds: [...this.sessionsByThread.entries()]
        .filter(([, managed]) => managed.session.activeTurnId !== null || (managed.session.backgroundTaskCount ?? 0) > 0)
        .map(([threadId]) => threadId),
      pendingApprovalIds: this.approvals.listPending().map((approval) => approval.approvalId),
    };
  }

  async listStoredThreads(request: ListStoredThreadsRequest): Promise<ListStoredThreadsResponse> {
    return listProviderThreads({
      providers: this.providers, directory: this.providerDirectory,
      hasStoredThreads: this.providerHasStoredThreads,
      listPage: async (provider, page) => (await this.getControlSession(provider)).listStoredThreads(page),
    }, request);
  }

  async listLoadedThreads(request: ListLoadedThreadsRequest): Promise<ListLoadedThreadsResponse> {
    const prefix = "shepherd-loaded:";
    const session = await this.getControlSession();
    // Accept native cursors issued by versions before application pagination.
    if (request.cursor && !request.cursor.startsWith(prefix)) {
      const page = await session.listLoadedThreads(request);
      return { threadIds: page.data, nextCursor: page.nextCursor };
    }
    const offset = request.cursor ? Number(request.cursor.slice(prefix.length)) : 0;
    const limit = request.limit ?? 20;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid loaded thread page.");
    const ids = new Set(this.sessionsByThread.keys());
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await session.listLoadedThreads({ cursor, limit: 100 });
      page.data.forEach(id => ids.add(id));
      if (!page.nextCursor) break;
      if (seen.has(page.nextCursor)) throw new Error("Provider returned a repeated loaded thread cursor.");
      seen.add(page.nextCursor); cursor = page.nextCursor;
    } while (true);
    const sorted = [...ids].sort();
    return { threadIds: sorted.slice(offset, offset + limit), nextCursor: offset + limit < sorted.length ? prefix + (offset + limit) : null };
  }

  getThreadState(threadId: string): GetThreadStateResponse {
    const managed = this.mustGet(threadId);
    return {
      threadId,
      sessionId: managed.session.sessionId,
      provider: this.threadProvider(threadId),
      capabilities: managed.session.capabilities,
      backgroundTaskCount: managed.session.backgroundTaskCount ?? 0,
      activeTurnId: managed.session.activeTurnId,
      approvalPolicy: managed.session.approvalPolicy,
    };
  }

  async listThreadTurns(threadId: string, request: ListThreadTurnsRequest): Promise<ListThreadTurnsResponse> {
    const session = this.sessionsByThread.get(threadId)?.session ?? await this.getControlSession(this.threadProvider(threadId));
    return session.listThreadTurns(threadId, request);
  }

  async listThreadItems(threadId: string, request: ListThreadItemsRequest): Promise<ListThreadItemsResponse> {
    const session = this.sessionsByThread.get(threadId)?.session ?? await this.getControlSession(this.threadProvider(threadId));
    return session.listThreadItems(threadId, request);
  }

  async readThread(threadId: string, request: ReadThreadRequest): Promise<ReadThreadResponse> {
    const session = this.mustGet(threadId).session;
    return session.readThread(threadId, request.includeTurns ?? false);
  }

  async setThreadName(threadId: string, request: SetThreadNameRequest): Promise<{ ok: true }> {
    const session = this.mustGet(threadId).session;
    await session.setThreadName(threadId, request.name);
    return { ok: true };
  }

  async archiveThread(threadId: string): Promise<ArchiveThreadResponse> {
    const session = this.mustGet(threadId).session;
    await session.archiveThread(threadId);
    return { ok: true };
  }

  async unarchiveThread(threadId: string): Promise<UnarchiveThreadResponse> {
    const session = this.sessionsByThread.get(threadId)?.session ?? await this.getControlSession(this.threadProvider(threadId));
    await session.unarchiveThread(threadId);
    return { ok: true };
  }

  async compactThread(threadId: string): Promise<CompactThreadResponse> {
    this.requireCapability(threadId, "compact");
    const session = this.mustGet(threadId).session;
    await session.compactThread(threadId);
    return { ok: true };
  }

  async revertThread(threadId: string, request: RevertThreadRequest): Promise<RevertThreadResponse> {
    this.requireCapability(threadId, "revert");
    const session = this.mustGet(threadId).session;
    const response = await session.revertThread(threadId, request.beforeTurnId);
    if (!response.thread) throw new Error("Revert did not return updated thread state.");
    return response;
  }

  async consumeRateLimitReset(request: ConsumeRateLimitResetRequest): Promise<ConsumeRateLimitResetResponse> {
    const session = await this.getControlSession();
    return session.consumeRateLimitReset(request);
  }

  async readAccountRateLimits(): Promise<AccountRateLimitsResponse> {
    const session = await this.getControlSession();
    return session.readAccountRateLimits();
  }

  async listModels(request: ListModelsRequest): Promise<ListModelsResponse> {
    const session = await this.getControlSession(request.provider ?? "codex");
    return session.listModels(request);
  }

  getThreadModel(threadId: string): ThreadModelState {
    this.mustGet(threadId);
    const state = this.modelStateByThread.get(threadId);
    return {
      threadId,
      currentModel: state?.currentModel ?? null,
      modelProvider: state?.modelProvider ?? null,
      pendingModel: state?.pendingModel ?? null,
    };
  }

  setThreadModel(threadId: string, model: string): ThreadModelState {
    this.mustGet(threadId);
    const current = this.modelStateByThread.get(threadId) ?? {
      currentModel: null,
      modelProvider: null,
      pendingModel: null,
    };
    const next = {
      ...current,
      pendingModel: model,
    };
    this.modelStateByThread.set(threadId, next);
    return {
      threadId,
      currentModel: next.currentModel,
      modelProvider: next.modelProvider,
      pendingModel: next.pendingModel,
    };
  }

  async getThreadEffort(threadId: string): Promise<ThreadEffortState> {
    const modelState = this.getThreadModel(threadId);
    const model = modelState.pendingModel ?? modelState.currentModel;
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const result = await this.listModels({ cursor, limit: 100, includeHidden: true, provider: this.threadProvider(threadId) });
      const entry = result.data.find((entry) => model ? entry.model === model : entry.isDefault);
      if (entry) {
        const state = this.effortStateByThread.get(threadId);
        return {
          threadId, model: entry.model,
          currentEffort: state?.current ?? null,
          pendingEffort: state?.pending ?? null,
          defaultEffort: entry.defaultReasoningEffort ?? null,
          supportedEfforts: entry.supportedReasoningEfforts ?? [],
        };
      }
      if (!result.nextCursor || seen.has(result.nextCursor)) break;
      seen.add(result.nextCursor);
      cursor = result.nextCursor;
    } while (true);
    throw new ApplicationActionError({ code: "model_unavailable" });
  }

  async setThreadEffort(threadId: string, requested: string): Promise<ThreadEffortState> {
    const state = await this.getThreadEffort(threadId);
    const effort = requested === "default" ? state.defaultEffort : requested;
    if (!effort || !state.supportedEfforts.some((option) => option.reasoningEffort === effort)) {
      throw new ApplicationActionError({ code: "unsupported_effort", model: state.model, requested, available: state.supportedEfforts.map((option) => option.reasoningEffort) });
    }
    this.effortStateByThread.set(threadId, { current: state.currentEffort, pending: effort });
    return { ...state, pendingEffort: effort };
  }

  async listSkills(threadId: string, request: SkillsListRequest): Promise<SkillsListResponse> {
    this.requireCapability(threadId, "skills");
    const managed = this.mustGet(threadId);
    const cwds = request.cwds ?? [await this.resolveThreadCwd(threadId)];
    return managed.session.listSkills({ ...request, cwds });
  }

  async getThreadCwd(threadId: string): Promise<string> {
    return this.resolveThreadCwd(threadId);
  }

  setThreadCwd(threadId: string, cwd: string): void {
    this.mustGet(threadId).session.setCwd?.(cwd);
    this.cwdByThread.set(threadId, cwd);
  }

  async writeSkillConfig(
    threadId: string,
    request: SkillsConfigWriteRequest,
  ): Promise<SkillsConfigWriteResponse> {
    this.requireCapability(threadId, "skills");
    const managed = this.mustGet(threadId);
    await this.resolveThreadCwd(threadId);
    return managed.session.writeSkillConfig(request);
  }

  async readThreadTokenUsage(threadId: string): Promise<ReadThreadTokenUsageResponse> {
    const tokenUsage = this.tokenUsageByThread.get(threadId) ?? null;
    return { threadId, tokenUsage };
  }

  subscribeToThreadEvents(
    threadId: string,
    listener: (event: import("../../shared/protocol/events.js").BridgeEvent) => void,
    cursorOrOptions?: string | { afterId?: string; replay?: boolean },
  ): () => void {
    const managed = this.mustGet(threadId);
    return managed.session.eventBus.subscribe(listener, cursorOrOptions);
  }

  private neutralProjection(threadId: string): ConversationProjection {
    const projection = this.mustGet(threadId).projection;
    if (!projection) throw new ProjectionRecoveryError("Neutral projection is unavailable for this session.");
    return projection;
  }
  readNeutralSnapshot(threadId: string) { return this.neutralProjection(threadId).snapshot(); }
  readNeutralSnapshotItems(threadId: string, cursor: string) { return this.neutralProjection(threadId).snapshotItems(cursor); }
  readNeutralItems(threadId: string, cursor?: string) { return this.neutralProjection(threadId).readItems(cursor); }
  readNeutralAsset(threadId: string, id: string) { return this.neutralProjection(threadId).readAsset(id); }
  subscribeNeutralEvents(threadId: string, listener: (event: import("../../shared/protocol/v2/events.js").BridgeEvent) => void, cursor?: ProjectionCursor, onClose?: () => void) {
    return this.neutralProjection(threadId).subscribe(listener, cursor, onClose);
  }

  async submitTurn(threadId: string, request: SubmitTurnRequest): Promise<SubmitTurnResponse> {
    const managed = this.mustGet(threadId);
    const modelState = this.modelStateByThread.get(threadId);
    const model = request.model ?? modelState?.pendingModel ?? undefined;
    const cwd = await this.resolveThreadCwd(threadId);
    const effortState = this.effortStateByThread.get(threadId);
    const effort = request.effort ?? effortState?.pending ?? undefined;
    const turnId = await managed.session.startTurn(request.input, request.approvalPolicy, model, cwd, effort);
    if (effort) {
      const latest = this.effortStateByThread.get(threadId);
      this.effortStateByThread.set(threadId, {
        current: effort,
        pending: latest?.pending === effort ? null : latest?.pending ?? null,
      });
    }
    if (model) {
      this.modelStateByThread.set(threadId, {
        currentModel: model,
        modelProvider: modelState?.modelProvider ?? null,
        pendingModel: null,
      });
    }
    return { ok: true, turnId };
  }

  async interruptTurn(threadId: string, turnId?: string): Promise<void> {
    const managed = this.mustGet(threadId);
    await managed.session.interruptTurn(turnId);
  }

  async steerTurn(threadId: string, request: SteerTurnRequest): Promise<SteerTurnResponse> {
    const managed = this.mustGet(threadId);
    const turnId = await managed.session.steerTurn(request.input, request.turnId);
    return { ok: true, turnId };
  }

  listApprovals(threadId: string): ApprovalRecord[] {
    return this.approvals.listByThread(threadId);
  }

  async applyApprovalDecision(
    threadId: string,
    approvalId: string,
    decision: ApprovalDecisionRequest,
  ): Promise<void> {
    const managed = this.mustGet(threadId);
    const { approval } = this.approvals.markDecided(threadId, approvalId, decision);

    const threadSession = managed.session;
    threadSession.eventBus.publish({
      id: `${threadSession.sessionId}:approval-decided:${approvalId}`,
      type: "approval.decided",
      threadId,
      sessionId: threadSession.sessionId,
      ts: new Date().toISOString(),
      payload: { approvalId, decision: decision.decision, state: approval.status },
    });

    try {
      await managed.session.applyApprovalDecision(approvalId, decision);
      this.approvals.markApplied(threadId, approvalId);
      threadSession.eventBus.publish({
        id: `${threadSession.sessionId}:approval-applied:${approvalId}`,
        type: "approval.applied",
        threadId,
        sessionId: threadSession.sessionId,
        ts: new Date().toISOString(),
        payload: { approvalId },
      });
    } catch (error) {
      this.approvals.markFailed(threadId, approvalId);
      threadSession.eventBus.publish({
        id: `${threadSession.sessionId}:approval-failed:${approvalId}`,
        type: "approval.failed",
        threadId,
        sessionId: threadSession.sessionId,
        ts: new Date().toISOString(),
        payload: {
          approvalId,
          message: error instanceof Error ? error.message : "Approval application failed.",
        },
      });
      throw error;
    }
  }

  stopAll(): void {
    this.stopped = true;
    for (const session of this.ownedSessions) this.releaseSession(session);
    this.sessionsByThread.clear();
    this.tokenUsageByThread.clear();
    this.cwdByThread.clear();
    this.modelStateByThread.clear();
    this.effortStateByThread.clear();
    this.controlSessions.clear();
  }

  private assertRunning(): void {
    if (this.stopped) throw new Error("Session manager is stopped.");
  }

  private allocateSession(approvalPolicy: ApprovalPolicy, provider: AgentProvider = "codex"): AgentSession {
    this.assertRunning();
    const session = this.sessionFactory(approvalPolicy, this.dynamicTools, provider);
    this.ownedSessions.add(session);
    this.attachSessionSubscriptions(session);
    return session;
  }

  private releaseSession(session: AgentSession): void {
    if (this.ownedSessions.delete(session)) {
      for (const managed of this.sessionsByThread.values()) if (managed.session === session) managed.projection?.close();
      try { session.stop(); }
      finally { this.sessionSubscriptions.get(session)?.(); this.sessionSubscriptions.delete(session); }
    }
  }

  private attachSessionSubscriptions(session: AgentSession): void {
    this.sessionSubscriptions.set(session, session.eventBus.subscribe((event) => {
      if (event.type === "approval.requested") {
        this.approvals.create(event.payload as ApprovalRequestPayload, {
          threadId: event.threadId,
          sessionId: session.sessionId,
        });
        return;
      }

      if (event.type === "approval.expired") {
        this.approvals.markExpired(event.threadId, (event.payload as { approvalId: string }).approvalId);
      }

      if (event.type === "turn.completed" || event.type === "turn.failed") {
        this.approvals.expireUserInput(event.threadId, (event.payload as { turnId?: string }).turnId);
      }

      if (event.type === "approval.failed") {
        const payload = event.payload as { approvalId: string };
        if (this.approvals.listByThread(event.threadId).some((a) => a.approvalId === payload.approvalId && a.status === "pending")) this.approvals.markFailed(event.threadId, payload.approvalId);
      }
      if (event.type === "thread.tokenUsage.updated") {
        const payload = event.payload as ThreadTokenUsageUpdatedEvent["payload"];
        if (!payload.tokenUsage) return;
        this.tokenUsageByThread.set(event.threadId, payload.tokenUsage);
      }
    }, { replay: false }));
  }

  getThreadProvider(threadId: string): AgentProvider { return this.threadProvider(threadId); }

  private threadProvider(threadId: string, requested?: AgentProvider): AgentProvider {
    const provider = this.providerDirectory.resolve(threadId);
    if (requested && requested !== provider) throw new Error("Cannot change the provider of an existing thread.");
    return provider;
  }

  private async getControlSession(provider: AgentProvider = "codex"): Promise<AgentSession> {
    this.assertRunning();
    const existing = this.controlSessions.get(provider);
    if (existing) return existing;
    const pending = this.controlSessionStarting.get(provider);
    if (pending) return pending;
    const session = this.allocateSession("on-request", provider);
    const starting = (async () => {
      try {
        await session.initialize();
        this.assertRunning();
        this.controlSessions.set(provider, session);
        return session;
      } catch (error) {
        this.releaseSession(session);
        throw error;
      }
    })();
    this.controlSessionStarting.set(provider, starting);
    try { return await starting; }
    finally { this.controlSessionStarting.delete(provider); }
  }

  private requireCapability(threadId: string, operation: "compact" | "revert" | "skills"): void {
    if (!this.mustGet(threadId).session.capabilities[operation]) throw new UnsupportedProviderOperationError(this.threadProvider(threadId), operation);
  }

  private mustGet(threadId: string): ManagedSession {
    const managed = this.sessionsByThread.get(threadId);
    if (!managed) {
      throw new Error(`Unknown thread ${threadId}.`);
    }
    return managed;
  }

  async resolveThreadCwd(threadId: string): Promise<string> {
    this.assertRunning();
    const cached = this.cwdByThread.get(threadId);
    if (cached) return cached;

    const session = this.sessionsByThread.get(threadId)?.session ?? await this.getControlSession(this.threadProvider(threadId));
    const raw = await session.readThread(threadId, false);
    const thread = raw.thread;
    const cwd = asString(thread.cwd);
    if (!cwd) {
      throw new ApplicationActionError({ code: "workspace_unavailable" });
    }
    if (this.sessionsByThread.has(threadId)) this.cwdByThread.set(threadId, cwd);
    return cwd;
  }
}
