import { assertThreadSupport, assertApprovalSupport, assertInputSupport } from "../../shared/protocol/provider_support.js";
import { listProviderThreads, threadSummary } from "./provider_thread_catalog.js";
import { ApplicationActionError } from "./action_error.js";
import type {
  ApprovalDecisionRequest,
  ApprovalRecord,
  ApprovalRequestPayload,
} from "../../shared/protocol/approvals.js";
import type { ThreadTokenUsageUpdatedEvent } from "../../shared/protocol/events.js";
import type {


  ApprovalPolicy,
  AgentProvider,

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
import { UnsupportedProviderOperationError, type ProviderSession } from "../ports/provider_session.js";
import type { ThreadProviderDirectory, ProviderSessionFactory } from "../ports/provider_services.js";
import { missingSessionFactory, memoryProviderDirectory } from "./provider_directory.js";
import { DynamicToolRegistry } from "./dynamic_tool_registry.js";

interface ManagedSession {
  session: ProviderSession;
  createdAt: string;
}

export type RuntimeActivity = {
  activeTurnThreadIds: string[];
  pendingApprovalIds: string[];
};

type ManagedModelState = {
  currentModel: string | null;
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
  private controlSessions = new Map<AgentProvider, ProviderSession>();
  private controlSessionStarting = new Map<AgentProvider, Promise<ProviderSession>>();
  private readonly ownedSessions = new Set<ProviderSession>();
  private readonly sessionSubscriptions = new Map<ProviderSession, () => void>();
  private readonly resuming = new Map<string, Promise<ResumeThreadResponse>>();
  private stopped = false;

  constructor(
    private readonly dynamicTools: DynamicToolRegistry = new DynamicToolRegistry(),
    private readonly sessionFactory: ProviderSessionFactory = missingSessionFactory,
    private readonly providerHasStoredThreads = (_provider: AgentProvider, _request: ListStoredThreadsRequest) => false,
    private readonly providerDirectory: ThreadProviderDirectory = memoryProviderDirectory(),
    private readonly providers: readonly AgentProvider[] = ["default"],
  ) {}

  async createThread(request: CreateThreadRequest): Promise<CreateThreadResponse> {
    return this.bootstrap(request, (session) => session.startThread(request));
  }

  async resumeThread(threadId: string, request: ResumeThreadRequest): Promise<ResumeThreadResponse> {
    this.assertRunning();
    this.threadProvider(threadId, request.provider);
    const existing = this.sessionsByThread.get(threadId);
    if (existing) {
      assertThreadSupport(this.threadProvider(threadId), existing.session.capabilities, request);
      return { threadId, sessionId: existing.session.sessionId };
    }
    const pending = this.resuming.get(threadId);
    if (pending) return pending;
    const operation = this.bootstrap({ ...request, provider: this.threadProvider(threadId, request.provider) }, (session) => session.resumeThread(threadId, request));
    this.resuming.set(threadId, operation);
    try { return await operation; }
    finally { this.resuming.delete(threadId); }
  }

  async forkThread(threadId: string, request: ForkThreadRequest): Promise<ForkThreadResponse> {
    return this.bootstrap({ ...request, provider: this.threadProvider(threadId, request.provider) }, (session) => { if (!session.capabilities.fork || !session.forkThread) throw new UnsupportedProviderOperationError(this.threadProvider(threadId), "fork"); return session.forkThread(threadId, request); });
  }

  private async bootstrap(
    request: CreateThreadRequest,
    start: (session: ProviderSession) => ReturnType<ProviderSession["startThread"]>,
  ): Promise<CreateThreadResponse> {
    const session = this.allocateSession(request.approvalPolicy ?? "provider_default", request.provider ?? this.defaultProvider());
    try {
      assertThreadSupport(request.provider ?? this.defaultProvider(), session.capabilities, request);
      assertApprovalSupport(request.provider ?? this.defaultProvider(), session.capabilities, request.approvalPolicy ?? session.approvalPolicy);
      const created = await start(session);
      this.assertRunning();
      this.providerDirectory.bind(created.threadId, request.provider ?? this.defaultProvider());
      this.sessionsByThread.set(created.threadId, { session, createdAt: new Date().toISOString() });
      if (request.cwd) this.cwdByThread.set(created.threadId, request.cwd);
      this.effortStateByThread.set(created.threadId, { current: created.effort, pending: null });
      this.modelStateByThread.set(created.threadId, { currentModel: created.model, pendingModel: null });
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
    if (request.cursor && !/^shepherd-loaded:\d+$/.test(request.cursor)) throw new Error("Invalid loaded thread cursor.");
    const offset = request.cursor ? Number(request.cursor.slice(prefix.length)) : 0;
    const limit = request.limit ?? 20;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid loaded thread page.");
    const ids = new Set(this.sessionsByThread.keys());
    await Promise.all(this.providers.map(async provider => {
      const session = await this.getControlSession(provider);
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const page = await session.listLoadedThreads({ cursor, limit: 100 });
        for (const id of page.data) { this.providerDirectory.bind(id, provider); ids.add(id); }
        if (!page.nextCursor) break;
        if (seen.has(page.nextCursor)) throw new Error("Provider returned a repeated loaded thread cursor.");
        seen.add(page.nextCursor); cursor = page.nextCursor;
      } while (true);
    }));
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
    if (!session.compactThread) throw new UnsupportedProviderOperationError(this.threadProvider(threadId), "compact");
    await session.compactThread(threadId);
    return { ok: true };
  }

  async revertThread(threadId: string, request: RevertThreadRequest): Promise<RevertThreadResponse> {
    this.requireCapability(threadId, "revert");
    const session = this.mustGet(threadId).session;
    if (!session.revertThread) throw new UnsupportedProviderOperationError(this.threadProvider(threadId), "revert");
    const response = await session.revertThread(threadId, request.beforeTurnId);
    if (!response.thread) throw new Error("Revert did not return updated thread state.");
    return response;
  }

  async listModels(request: ListModelsRequest): Promise<ListModelsResponse> {
    const session = await this.getControlSession(request.provider ?? this.defaultProvider());
    return session.listModels(request);
  }

  getThreadModel(threadId: string): ThreadModelState {
    this.mustGet(threadId);
    const state = this.modelStateByThread.get(threadId);
    return {
      threadId,
      provider: this.threadProvider(threadId),
      currentModel: state?.currentModel ?? null,
      pendingModel: state?.pendingModel ?? null,
    };
  }

  setThreadModel(threadId: string, model: string): ThreadModelState {
    this.mustGet(threadId);
    const current = this.modelStateByThread.get(threadId) ?? {
      currentModel: null,
      pendingModel: null,
    };
    const next = {
      ...current,
      pendingModel: model,
    };
    this.modelStateByThread.set(threadId, next);
    return {
      threadId,
      provider: this.threadProvider(threadId),
      currentModel: next.currentModel,
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
      const entry = result.data.find((entry) => model ? entry.id === model : entry.isDefault);
      if (entry) {
        const state = this.effortStateByThread.get(threadId);
        return {
          threadId, model: entry.id,
          currentEffort: state?.current ?? null,
          pendingEffort: state?.pending ?? null,
          defaultEffort: entry.defaultEffort,
          supportedEfforts: entry.supportedEfforts,
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
    if (!effort || !state.supportedEfforts.some((option) => option.value === effort)) {
      throw new ApplicationActionError({ code: "unsupported_effort", model: state.model, requested, available: state.supportedEfforts.map((option) => option.value) });
    }
    this.effortStateByThread.set(threadId, { current: state.currentEffort, pending: effort });
    return { ...state, pendingEffort: effort };
  }

  async listSkills(threadId: string, request: SkillsListRequest): Promise<SkillsListResponse> {
    this.requireCapability(threadId, "skills");
    const managed = this.mustGet(threadId);
    const cwds = request.cwds ?? [await this.resolveThreadCwd(threadId)];
    if (!managed.session.listSkills) throw new UnsupportedProviderOperationError(this.threadProvider(threadId), "skills");
    return managed.session.listSkills({ ...request, cwds });
  }

  async getThreadCwd(threadId: string): Promise<string> {
    return this.resolveThreadCwd(threadId);
  }

  setThreadCwd(threadId: string, cwd: string): void {
    this.mustGet(threadId).session.setCwd(cwd);
    this.cwdByThread.set(threadId, cwd);
  }

  async writeSkillConfig(
    threadId: string,
    request: SkillsConfigWriteRequest,
  ): Promise<SkillsConfigWriteResponse> {
    this.requireCapability(threadId, "skills");
    const managed = this.mustGet(threadId);
    await this.resolveThreadCwd(threadId);
    if (!managed.session.writeSkillConfig) throw new UnsupportedProviderOperationError(this.threadProvider(threadId), "skill configuration");
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

  async submitTurn(threadId: string, request: SubmitTurnRequest): Promise<SubmitTurnResponse> {
    const managed = this.mustGet(threadId);
    assertApprovalSupport(this.threadProvider(threadId), managed.session.capabilities, request.approvalPolicy ?? managed.session.approvalPolicy);
    assertInputSupport(this.threadProvider(threadId), managed.session.capabilities, request.input);
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
    assertInputSupport(this.threadProvider(threadId), managed.session.capabilities, request.input);
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

  private defaultProvider(): string {
    const provider = this.providers[0];
    if (!provider) throw new Error("No agent providers are registered.");
    return provider;
  }

  private allocateSession(approvalPolicy: ApprovalPolicy, provider: AgentProvider = this.defaultProvider()): ProviderSession {
    this.assertRunning();
    const session = this.sessionFactory(approvalPolicy, this.dynamicTools, provider);
    this.ownedSessions.add(session);
    this.attachSessionSubscriptions(session);
    return session;
  }

  private releaseSession(session: ProviderSession): void {
    if (this.ownedSessions.delete(session)) {
      try { session.stop(); }
      finally { this.sessionSubscriptions.get(session)?.(); this.sessionSubscriptions.delete(session); }
    }
  }

  private attachSessionSubscriptions(session: ProviderSession): void {
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

      if (event.type === "approval.applied") {
        const payload = event.payload as { approvalId: string };
        if (this.approvals.listByThread(event.threadId).some(a => a.approvalId === payload.approvalId && a.status === "pending")) this.approvals.markApplied(event.threadId, payload.approvalId);
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

  private async getControlSession(provider: AgentProvider = this.defaultProvider()): Promise<ProviderSession> {
    this.assertRunning();
    const existing = this.controlSessions.get(provider);
    if (existing) return existing;
    const pending = this.controlSessionStarting.get(provider);
    if (pending) return pending;
    const session = this.allocateSession("provider_default", provider);
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
