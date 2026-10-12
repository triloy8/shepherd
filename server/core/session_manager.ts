import type { ProviderCapabilities, ProviderOperation } from "../../shared/protocol/provider_capabilities.js";
import { assertThreadSupport, assertApprovalSupport, assertInputSupport, assertProviderOperation, unsupportedThreadDefaults, type ThreadDefaults } from "../../shared/protocol/provider_support.js";
import { unsupportedModelInput, UnsupportedModelInputError } from "../../shared/protocol/model_capabilities.js";
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
  EffortSelection,
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
  ModelSummary,
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
import { UnsupportedProviderOperationError, type ProviderSession, type LoadedThreadPage } from "../ports/provider_session.js";
import type { ThreadProviderDirectory, ProviderSessionFactory } from "../ports/provider_services.js";
import { missingSessionFactory, memoryProviderDirectory } from "./provider_directory.js";
import { DynamicToolRegistry } from "./dynamic_tool_registry.js";
import { EventBus } from "../ports/event_bus.js";

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
export type { ThreadDefaults };

export class SessionManager {
  private sessionsByThread = new Map<string, ManagedSession>();
  private approvals = new ApprovalsStore();
  private tokenUsageByThread = new Map<string, ThreadTokenUsage>();
  private cwdByThread = new Map<string, string>();
  private effortStateByThread = new Map<string, { current: string | null; pending: string | null; pendingClear?: boolean }>();
  private modelStateByThread = new Map<string, ManagedModelState>();
  private controlSessions = new Map<AgentProvider, ProviderSession>();
  private controlSessionStarting = new Map<AgentProvider, Promise<ProviderSession>>();
  private readonly providerCapabilities = new Map<AgentProvider, ProviderCapabilities>();
  private readonly ownedSessions = new Set<ProviderSession>();
  private readonly sessionSubscriptions = new Map<ProviderSession, () => void>();
  private readonly applicationEvents = new Map<ProviderSession, EventBus>();
  private readonly resuming = new Map<string, Promise<ResumeThreadResponse>>();
  private stopped = false;

  constructor(
    private readonly dynamicTools: DynamicToolRegistry = new DynamicToolRegistry(),
    private readonly sessionFactory: ProviderSessionFactory = missingSessionFactory,
    private readonly providerHasStoredThreads = (_provider: AgentProvider, _request: ListStoredThreadsRequest) => true,
    private readonly providerDirectory: ThreadProviderDirectory = memoryProviderDirectory(),
    private readonly providers: readonly AgentProvider[] = ["default"],
    private readonly fallbackProvider: AgentProvider = providers[0] ?? "default",
    private readonly threadDefaults: ThreadDefaults = {},
  ) {}

  async createThread(request: CreateThreadRequest): Promise<CreateThreadResponse> {
    return this.bootstrap(request, (session, effective) => session.startThread(effective), undefined, true);
  }

  async resumeThread(threadId: string, request: ResumeThreadRequest): Promise<ResumeThreadResponse> {
    this.assertRunning();
    this.threadProvider(threadId, request.provider);
    const existing = this.sessionsByThread.get(threadId);
    if (existing) {
      assertThreadSupport(this.threadProvider(threadId), existing.session.capabilities, request);
      if (existing.session.capabilities.modelCatalog && (request.model || request.effort)) {
        const selected = await this.resolveModel(this.threadProvider(threadId), request.model ?? this.modelStateByThread.get(threadId)?.currentModel);
        this.assertModelEffort(selected, request.effort);
      }
      return { threadId, sessionId: existing.session.sessionId };
    }
    const pending = this.resuming.get(threadId);
    if (pending) return pending;
    const operation = this.bootstrap({ ...request, provider: this.threadProvider(threadId, request.provider) }, (session, effective) => session.resumeThread(threadId, effective), threadId);
    this.resuming.set(threadId, operation);
    try { return await operation; }
    finally { this.resuming.delete(threadId); }
  }

  async forkThread(threadId: string, request: ForkThreadRequest): Promise<ForkThreadResponse> {
    return this.bootstrap({ ...request, provider: this.threadProvider(threadId, request.provider) }, (session, effective) => { if (!session.capabilities.fork || !session.forkThread) throw new UnsupportedProviderOperationError(this.threadProvider(threadId), "fork"); return session.forkThread(threadId, effective); }, threadId);
  }

  /** Resume and fork keep the saved approval mode, so only creation applies the host approval default. */
  private async bootstrap(
    requested: CreateThreadRequest,
    start: (session: ProviderSession, request: CreateThreadRequest) => ReturnType<ProviderSession["startThread"]>,
    sourceThreadId?: string,
    applyApprovalDefault = false,
  ): Promise<CreateThreadResponse> {
    const session = this.allocateSession(requested.approvalPolicy ?? "provider_default", requested.provider ?? this.defaultProvider());
    try {
      const request = this.withThreadDefaults(requested, session.capabilities, applyApprovalDefault);
      assertThreadSupport(request.provider ?? this.defaultProvider(), session.capabilities, request);
      assertApprovalSupport(request.provider ?? this.defaultProvider(), session.capabilities, request.approvalPolicy ?? session.approvalPolicy);
      if (session.capabilities.modelCatalog && (request.model || request.effort)) {
        const savedModel = !request.model && sourceThreadId
          ? asString((await session.readThread(sourceThreadId, false)).thread.model) : null;
        const selected = await this.resolveModel(request.provider ?? this.defaultProvider(), request.model ?? savedModel, session);
        this.assertModelEffort(selected, request.effort);
      }
      const created = await start(session, request);
      this.assertRunning();
      if (typeof created.cwd !== "string" || !created.cwd.trim()) {
        throw new ApplicationActionError({ code: "workspace_unavailable" });
      }
      this.providerDirectory.bind(created.threadId, request.provider ?? this.defaultProvider());
      this.sessionsByThread.set(created.threadId, { session, createdAt: new Date().toISOString() });
      this.cwdByThread.set(created.threadId, created.cwd);
      this.effortStateByThread.set(created.threadId, { current: created.effort, pending: null });
      this.modelStateByThread.set(created.threadId, { currentModel: created.model, pendingModel: null });
      return { threadId: created.threadId, sessionId: session.sessionId };
    } catch (error) {
      this.releaseSession(session);
      throw error;
    }
  }

  private withThreadDefaults(request: CreateThreadRequest, capabilities: ProviderCapabilities, applyApproval: boolean): CreateThreadRequest {
    const unsupported = unsupportedThreadDefaults(this.threadDefaults, capabilities);
    const { approvalPolicy, sandbox } = this.threadDefaults;
    return {
      ...request,
      ...(applyApproval && request.approvalPolicy === undefined && approvalPolicy && !unsupported.includes("approvalPolicy") ? { approvalPolicy } : {}),
      ...(request.sandbox === undefined && sandbox && !unsupported.includes("sandbox") ? { sandbox } : {}),
    };
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
    this.assertRunning();
    const result = await listProviderThreads({
      providers: this.providers, directory: this.providerDirectory,
      hasStoredThreads: this.providerHasStoredThreads,
      canUnarchive: provider => this.providerCapabilities.get(provider)?.unarchive ?? false,
      listPage: async (provider, page) => (await this.getControlSession(provider)).listStoredThreads(page),
    }, request);
    this.assertRunning();
    return result;
  }

  async listLoadedThreads(request: ListLoadedThreadsRequest): Promise<ListLoadedThreadsResponse> {
    const prefix = "shepherd-loaded:";
    if (request.cursor && !/^shepherd-loaded:\d+$/.test(request.cursor)) throw new Error("Invalid loaded thread cursor.");
    const offset = request.cursor ? Number(request.cursor.slice(prefix.length)) : 0;
    const limit = request.limit ?? 20;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid loaded thread page.");
    this.assertRunning();
    const unavailableProviders: AgentProvider[] = [];
    const ids = new Set(this.sessionsByThread.keys());
    await Promise.all(this.providers.map(async provider => {
      let session: ProviderSession;
      try { session = await this.getControlSession(provider); }
      catch { this.assertRunning(); unavailableProviders.push(provider); return; }
      if (!session.listLoadedThreads) return;
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        let page: LoadedThreadPage;
        try { page = await session.listLoadedThreads({ cursor, limit: 100 }); }
        catch { this.assertRunning(); unavailableProviders.push(provider); return; }
        for (const id of page.data) { this.providerDirectory.bind(id, provider); ids.add(id); }
        if (!page.nextCursor) break;
        if (seen.has(page.nextCursor)) throw new Error("Provider returned a repeated loaded thread cursor.");
        seen.add(page.nextCursor); cursor = page.nextCursor;
      } while (true);
    }));
    this.assertRunning();
    const sorted = [...ids].sort();
    return { ...(unavailableProviders.length ? { unavailableProviders: unavailableProviders.sort() } : {}), threadIds: sorted.slice(offset, offset + limit), nextCursor: offset + limit < sorted.length ? prefix + (offset + limit) : null };
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
    assertProviderOperation(this.threadProvider(threadId), session.capabilities, "rename");
    if (!session.setThreadName) throw new UnsupportedProviderOperationError(this.threadProvider(threadId), "rename");
    await session.setThreadName(threadId, request.name);
    return { ok: true };
  }

  async archiveThread(threadId: string): Promise<ArchiveThreadResponse> {
    const session = this.mustGet(threadId).session;
    assertProviderOperation(this.threadProvider(threadId), session.capabilities, "archive");
    if (!session.archiveThread) throw new UnsupportedProviderOperationError(this.threadProvider(threadId), "archive");
    await session.archiveThread(threadId);
    return { ok: true };
  }

  async unarchiveThread(threadId: string): Promise<UnarchiveThreadResponse> {
    const session = this.sessionsByThread.get(threadId)?.session ?? await this.getControlSession(this.threadProvider(threadId));
    assertProviderOperation(this.threadProvider(threadId), session.capabilities, "unarchive");
    if (!session.unarchiveThread) throw new UnsupportedProviderOperationError(this.threadProvider(threadId), "unarchive");
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
    assertProviderOperation(request.provider ?? this.defaultProvider(), session.capabilities, "modelCatalog");
    if (!session.listModels) throw new UnsupportedProviderOperationError(request.provider ?? this.defaultProvider(), "modelCatalog");
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
    this.requireCapability(threadId, "modelSelection");
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

  async getThreadEffort(threadId: string, requestedModel?: string): Promise<ThreadEffortState> {
    const modelState = this.getThreadModel(threadId);
    const model = requestedModel ?? modelState.pendingModel ?? modelState.currentModel;
    const entry = this.mustGet(threadId).session.capabilities.modelCatalog
      ? await this.resolveModel(this.threadProvider(threadId), model)
      : { id: model ?? "", inputModalities: null, defaultEffort: null, supportedEfforts: [] };
    const state = this.effortStateByThread.get(threadId);
    return {
      threadId, model: entry.id,
      currentEffort: state?.current ?? null, pendingEffort: state?.pending ?? null, pendingEffortClear: state?.pendingClear ?? false,
      inputModalities: entry.inputModalities,
      defaultEffort: entry.defaultEffort, supportedEfforts: entry.supportedEfforts,
    };
  }

  private async resolveModel(provider: AgentProvider, model: string | null | undefined, session?: ProviderSession): Promise<ModelSummary> {
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const request = { cursor, limit: 100, includeHidden: true, provider };
      const result = session?.listModels ? await session.listModels(request) : await this.listModels(request);
      const entry = result.data.find((entry) => model ? entry.id === model : entry.isDefault);
      if (entry) return entry;
      if (!result.nextCursor || seen.has(result.nextCursor)) break;
      seen.add(result.nextCursor);
      cursor = result.nextCursor;
    } while (true);
    throw new ApplicationActionError({ code: "model_unavailable" });
  }

  private assertModelEffort(model: ModelSummary, effort: string | null | undefined): void {
    if (effort && !model.supportedEfforts.some(option => option.value === effort)) {
      throw new ApplicationActionError({ code: "unsupported_effort", model: model.id, requested: effort, available: model.supportedEfforts.map(option => option.value) });
    }
  }

  private assertModelInput(model: ModelSummary, input: readonly import("../../shared/protocol/user_input.js").UserInput[]): void {
    const modality = unsupportedModelInput(model, input);
    if (modality) throw new UnsupportedModelInputError(model.id, modality);
  }

  async setThreadEffort(threadId: string, requested: EffortSelection): Promise<ThreadEffortState> {
    this.requireCapability(threadId, "effortSelection");
    const state = await this.getThreadEffort(threadId);
    const effort = requested === null ? null : typeof requested === "string" ? requested : state.defaultEffort;
    if (requested !== null && (!effort || !state.supportedEfforts.some((option) => option.value === effort))) {
      throw new ApplicationActionError({ code: "unsupported_effort", model: state.model, requested: typeof requested === "string" ? requested : "model default", available: state.supportedEfforts.map((option) => option.value) });
    }
    this.effortStateByThread.set(threadId, { current: state.currentEffort, pending: effort, pendingClear: effort === null });
    return { ...state, pendingEffort: effort, pendingEffortClear: effort === null };
  }

  async listSkills(threadId: string, request: SkillsListRequest): Promise<SkillsListResponse> {
    this.requireCapability(threadId, "skills");
    const managed = this.mustGet(threadId);
    const workspacePath = await this.resolveThreadCwd(threadId);
    if (!managed.session.listSkills) throw new UnsupportedProviderOperationError(this.threadProvider(threadId), "skills");
    return managed.session.listSkills({ refresh: request.refresh, workspacePath });
  }

  async getThreadCwd(threadId: string): Promise<string> {
    return this.resolveThreadCwd(threadId);
  }

  setThreadCwd(threadId: string, cwd: string): void {
    // Keeping the current workspace is not a workspace change.
    if (this.sessionsByThread.has(threadId) && this.cwdByThread.get(threadId) === cwd) return;
    this.requireCapability(threadId, "workspaceChange");
    const session = this.mustGet(threadId).session;
    if (!session.setCwd) throw new UnsupportedProviderOperationError(this.threadProvider(threadId), "workspaceChange");
    session.setCwd(cwd);
    this.cwdByThread.set(threadId, cwd);
  }

  async writeSkillConfig(
    threadId: string,
    request: SkillsConfigWriteRequest,
  ): Promise<SkillsConfigWriteResponse> {
    this.requireCapability(threadId, "skillConfig");
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
    return this.applicationEvents.get(managed.session)!.subscribe(listener, cursorOrOptions);
  }

  async submitTurn(threadId: string, request: SubmitTurnRequest): Promise<SubmitTurnResponse> {
    const managed = this.mustGet(threadId);
    assertApprovalSupport(this.threadProvider(threadId), managed.session.capabilities, request.approvalPolicy ?? managed.session.approvalPolicy);
    assertInputSupport(this.threadProvider(threadId), managed.session.capabilities, request.input);
    const modelState = this.modelStateByThread.get(threadId);
    const model = request.model ?? modelState?.pendingModel ?? undefined;
    const cwd = await this.resolveThreadCwd(threadId);
    const effortState = this.effortStateByThread.get(threadId);
    let effort: string | null | undefined = request.effort !== undefined ? request.effort : effortState?.pendingClear ? null : effortState?.pending ?? undefined;
    if (model) this.requireCapability(threadId, "modelSelection");
    if (effort || request.effort === null || effortState?.pendingClear) this.requireCapability(threadId, "effortSelection");
    if (managed.session.capabilities.modelCatalog) {
      const selected = await this.resolveModel(this.threadProvider(threadId), model ?? modelState?.currentModel);
      this.assertModelInput(selected, request.input);
      if (effort === undefined && effortState?.current && !selected.supportedEfforts.some(option => option.value === effortState.current)) {
        // Preserve inherited effort only while the selected model supports it.
        effort = selected.defaultEffort;
      }
      this.assertModelEffort(selected, effort);
    }
    if (effort || request.effort === null || effortState?.pendingClear) this.requireCapability(threadId, "effortSelection");
    const turnId = await managed.session.startTurn(request.input, request.approvalPolicy, model, cwd, effort);
    if (effort !== undefined) {
      const latest = this.effortStateByThread.get(threadId);
      this.effortStateByThread.set(threadId, {
        current: effort,
        pending: latest?.pending === effort ? null : latest?.pending ?? null,
        pendingClear: effort === null ? false : latest?.pendingClear ?? false,
      });
    }
    if (model) {
      this.modelStateByThread.set(threadId, {
        currentModel: model,
        pendingModel: this.modelStateByThread.get(threadId)?.pendingModel === model ? null : this.modelStateByThread.get(threadId)?.pendingModel ?? null,
      });
    }
    return { ok: true, turnId };
  }

  async interruptTurn(threadId: string, turnId?: string): Promise<void> {
    const managed = this.mustGet(threadId);
    this.requireCapability(threadId, "interrupt");
    if (!managed.session.interruptTurn) throw new UnsupportedProviderOperationError(this.threadProvider(threadId), "interrupt");
    await managed.session.interruptTurn(turnId);
  }

  async steerTurn(threadId: string, request: SteerTurnRequest): Promise<SteerTurnResponse> {
    this.requireCapability(threadId, "steer");
    const managed = this.mustGet(threadId);
    if (!managed.session.steerTurn) throw new UnsupportedProviderOperationError(this.threadProvider(threadId), "steer");
    assertInputSupport(this.threadProvider(threadId), managed.session.capabilities, request.input);
    if (managed.session.capabilities.modelCatalog) {
      const model = await this.resolveModel(this.threadProvider(threadId), this.modelStateByThread.get(threadId)?.currentModel);
      this.assertModelInput(model, request.input);
    }
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
    if (!this.providers.includes(this.fallbackProvider)) throw new Error("No default agent provider is registered.");
    return this.fallbackProvider;
  }

  private allocateSession(approvalPolicy: ApprovalPolicy, provider: AgentProvider = this.defaultProvider()): ProviderSession {
    this.assertRunning();
    const session = this.sessionFactory(approvalPolicy, this.dynamicTools, provider);
    this.providerCapabilities.set(provider, session.capabilities);
    this.ownedSessions.add(session);
    this.attachSessionSubscriptions(session);
    return session;
  }

  private releaseSession(session: ProviderSession): void {
    if (this.ownedSessions.delete(session)) {
      try { session.stop(); }
      finally {
        this.sessionSubscriptions.get(session)?.();
        this.sessionSubscriptions.delete(session);
        this.applicationEvents.delete(session);
      }
    }
  }

  private attachSessionSubscriptions(session: ProviderSession): void {
    const events = new EventBus();
    const rejectedQuestions = new Set<string>();
    this.applicationEvents.set(session, events);
    this.sessionSubscriptions.set(session, session.eventBus.subscribe((event) => {
      if (event.type.startsWith("approval.") && "approvalId" in event.payload && rejectedQuestions.has(event.payload.approvalId)) return;
      if (event.type === "approval.requested") {
        if (event.payload.kind === "question" && !session.capabilities.questions) {
          const { approvalId, choices } = event.payload;
          rejectedQuestions.add(approvalId);
          // Never expose this request, including through replay. Resolve the provider's pending request.
          void Promise.resolve().then(async () => {
            if (!this.ownedSessions.has(session)) return;
            let message = "This agent does not support questions.";
            try {
              const cancellation = choices.find(choice => choice.intent === "cancel" || choice.intent === "deny");
              if (!cancellation) throw new Error("The question has no cancellation choice.");
              await session.applyApprovalDecision(approvalId, { decision: cancellation.value, reason: message });
            } catch (error) {
              message += ` The session was stopped because cancellation failed: ${error instanceof Error ? error.message : String(error)}`;
              const turnId = session.activeTurnId;
              if (turnId) events.publish({ ...event, id: `${event.id}:turn-failed`, type: "turn.failed", payload: { turnId, message } });
              events.publish({ ...event, id: `${event.id}:session-error`, type: "session.error", payload: { message } });
              for (const [threadId, managed] of this.sessionsByThread) if (managed.session === session) this.discardThreadSession(threadId);
              this.releaseSession(session);
            }
            events.publish({ ...event, id: `${event.id}:rejected`, type: "approval.failed", payload: { approvalId, message } });
          });
          return;
        }
        this.approvals.create(event.payload as ApprovalRequestPayload, {
          threadId: event.threadId,
          sessionId: session.sessionId,
        });
        events.publish(event);
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
        if (payload.tokenUsage) this.tokenUsageByThread.set(event.threadId, payload.tokenUsage);
      }
      events.publish(event);
    }, { replay: false }));
  }

  /** Release an unusable session without deleting its provider history or workspace. */
  private discardThreadSession(threadId: string): void {
    this.sessionsByThread.delete(threadId);
    this.cwdByThread.delete(threadId);
    this.tokenUsageByThread.delete(threadId);
    this.effortStateByThread.delete(threadId);
    this.modelStateByThread.delete(threadId);
    for (const approval of this.approvals.listByThread(threadId)) if (approval.status === "pending") this.approvals.markExpired(threadId, approval.approvalId);
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

  private requireCapability(threadId: string, operation: ProviderOperation): void {
    assertProviderOperation(this.threadProvider(threadId), this.mustGet(threadId).session.capabilities, operation);
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
