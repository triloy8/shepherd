import { randomUUID } from "node:crypto";
import type { BridgeEvent } from "../../../shared/protocol/events.js";
import type { ProviderCapabilities, ProviderOperation } from "../../../shared/protocol/provider_capabilities.js";
import { assertThreadSupport, assertInputSupport, assertProviderOperation, resolveThreadProfile, threadPolicy, type ThreadDefaults } from "../../../shared/protocol/provider_support.js";
import { unsupportedModelInput, UnsupportedModelInputError } from "../../../shared/protocol/model_capabilities.js";
import { listProviderThreads, threadSummary } from "./provider_thread_catalog.js";
import { ApplicationActionError } from "../common/action_error.js";
import type {
  ApprovalDecisionRequest,
  ApprovalRecord,
  ApprovalRequestPayload,
} from "../../../shared/protocol/approvals.js";
import type { ThreadTokenUsageUpdatedEvent } from "../../../shared/protocol/events.js";
import type {


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
} from "../../../shared/protocol/requests.js";
import { ApprovalsStore } from "./approvals.js";
import { UnsupportedProviderOperationError, type Provider, type ProviderThreadRequest, type ThreadSession as ProviderSession, type LoadedThreadPage } from "../../ports/provider_session.js";
import type { ThreadProviderDirectory, ProviderLookup } from "../../ports/provider_services.js";
import { missingProviders, memoryProviderDirectory } from "./provider_directory.js";
import { DynamicToolRegistry } from "./dynamic_tool_registry.js";
import { EventBus } from "../../ports/event_bus.js";

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

/** What core knows about a running thread, learned from its bootstrap and events. */
type ThreadRuntime = { activeTurnId: string | null; backgroundTaskCount: number; profile: string | null };

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
  private runtimeByThread = new Map<string, ThreadRuntime>();
  /** The turn each session is running, for requests that arrive without naming one. */
  private readonly sessionTurns = new Map<ProviderSession, string | null>();
  private readonly providerCapabilities = new Map<AgentProvider, ProviderCapabilities>();
  private readonly ownedSessions = new Set<ProviderSession>();
  private readonly sessionSubscriptions = new Map<ProviderSession, () => void>();
  private readonly applicationEvents = new Map<ProviderSession, EventBus>();
  private readonly resuming = new Map<string, Promise<ResumeThreadResponse>>();
  private stopped = false;
  /** New turns wait while a restart lets running work finish. */
  private newTurnsPaused = false;

  constructor(
    private readonly dynamicTools: DynamicToolRegistry = new DynamicToolRegistry(),
    private readonly providerFor: ProviderLookup = missingProviders,
    private readonly providerHasStoredThreads = (_provider: AgentProvider, _request: ListStoredThreadsRequest) => true,
    private readonly providerDirectory: ThreadProviderDirectory = memoryProviderDirectory(),
    private readonly providers: readonly AgentProvider[] = ["default"],
    private readonly fallbackProvider: AgentProvider = providers[0] ?? "default",
    private readonly threadDefaults: ThreadDefaults = {},
  ) {}

  async createThread(request: CreateThreadRequest): Promise<CreateThreadResponse> {
    return this.bootstrap(request, (session, effective) => session.startThread(effective));
  }

  async resumeThread(threadId: string, request: ResumeThreadRequest): Promise<ResumeThreadResponse> {
    this.assertRunning();
    this.threadProvider(threadId, request.provider);
    const existing = this.sessionsByThread.get(threadId);
    if (existing) {
      assertThreadSupport(this.threadProvider(threadId), existing.session.capabilities, request);
      if (existing.session.capabilities.modelCatalog && (request.model || request.effort)) {
        const selected = await this.resolveModel(this.threadProvider(threadId), request.model ?? this.modelStateByThread.get(threadId)?.currentModel, existing.session, !!request.model && existing.session.capabilities.modelCatalogAuthoritative === true, threadId);
        if (selected) this.assertModelEffort(selected, request.effort);
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

  /** Create, resume and fork run within the requested policy, or the host policy when none is
   * requested: providers do not all record a thread's mode, so every bootstrap states it. */
  private async bootstrap(
    requested: CreateThreadRequest,
    start: (session: ProviderSession, request: ProviderThreadRequest) => ReturnType<ProviderSession["startThread"]>,
    sourceThreadId?: string,
  ): Promise<CreateThreadResponse> {
    const session = this.allocateSession(requested.provider ?? this.defaultProvider());
    try {
      const { policy: _policy, provider: _provider, ...settings } = requested;
      const request: ProviderThreadRequest & { provider?: AgentProvider } = { ...settings, provider: requested.provider,
        profile: resolveThreadProfile(requested.provider ?? this.defaultProvider(), session.capabilities, requested.policy, this.threadDefaults.policy) };
      assertThreadSupport(request.provider ?? this.defaultProvider(), session.capabilities, request);
      await session.initialize();
      this.assertRunning();
      const preBootstrapCatalog = session.capabilities.modelCatalogScope === "provider";
      if (session.capabilities.modelCatalog && preBootstrapCatalog && (request.model || request.effort)) {
        const savedModel = !request.model && sourceThreadId
          ? asString((await this.provider(request.provider ?? this.defaultProvider()).readThread(sourceThreadId, false)).thread.model) : null;
        const selected = await this.resolveModel(request.provider ?? this.defaultProvider(), request.model ?? savedModel, session, !!request.model && session.capabilities.modelCatalogAuthoritative === true);
        if (selected) this.assertModelEffort(selected, request.effort);
      }
      const { provider: _selected, ...native } = request;
      const created = await start(session, native);
      this.assertRunning();
      if (session.capabilities.modelCatalog && !preBootstrapCatalog && (request.model || request.effort)) {
        const selected = await this.resolveModel(request.provider ?? this.defaultProvider(), request.model ?? created.model, session, !!request.model && session.capabilities.modelCatalogAuthoritative === true, created.threadId);
        if (selected) this.assertModelEffort(selected, request.effort);
      }
      if (typeof created.cwd !== "string" || !created.cwd.trim()) {
        throw new ApplicationActionError({ code: "workspace_unavailable" });
      }
      this.providerDirectory.bind(created.threadId, request.provider ?? this.defaultProvider());
      this.sessionsByThread.set(created.threadId, { session, createdAt: new Date().toISOString() });
      this.cwdByThread.set(created.threadId, created.cwd);
      this.effortStateByThread.set(created.threadId, { current: created.effort, pending: null });
      this.modelStateByThread.set(created.threadId, { currentModel: created.model, pendingModel: null });
      this.runtimeByThread.set(created.threadId, { activeTurnId: null, backgroundTaskCount: 0, profile: created.profile });
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
        .filter(([threadId]) => { const runtime = this.runtimeByThread.get(threadId); return !!runtime && (runtime.activeTurnId !== null || runtime.backgroundTaskCount > 0); })
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
      listPage: (provider, page) => this.provider(provider).listStoredThreads(page),
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
      const session = this.provider(provider);
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
      capabilities: { ...managed.session.capabilities, modelCatalogAuthoritative: managed.session.capabilities.modelCatalogAuthoritative === true },
      backgroundTaskCount: this.runtime(threadId).backgroundTaskCount,
      activeTurnId: this.runtime(threadId).activeTurnId,
      policy: threadPolicy(managed.session.capabilities, this.runtime(threadId).profile),
    };
  }

  async listThreadTurns(threadId: string, request: ListThreadTurnsRequest): Promise<ListThreadTurnsResponse> {
    this.assertRunning();
    return this.provider(this.threadProvider(threadId)).listThreadTurns(threadId, request);
  }

  async listThreadItems(threadId: string, request: ListThreadItemsRequest): Promise<ListThreadItemsResponse> {
    this.assertRunning();
    return this.provider(this.threadProvider(threadId)).listThreadItems(threadId, request);
  }

  async readThread(threadId: string, request: ReadThreadRequest): Promise<ReadThreadResponse> {
    this.mustGet(threadId);
    return this.provider(this.threadProvider(threadId)).readThread(threadId, request.includeTurns ?? false);
  }

  async setThreadName(threadId: string, request: SetThreadNameRequest): Promise<{ ok: true }> {
    this.mustGet(threadId);
    const provider = this.provider(this.threadProvider(threadId));
    assertProviderOperation(this.threadProvider(threadId), provider.capabilities, "rename");
    if (!provider.setThreadName) throw new UnsupportedProviderOperationError(this.threadProvider(threadId), "rename");
    await provider.setThreadName(threadId, request.name);
    return { ok: true };
  }

  async archiveThread(threadId: string): Promise<ArchiveThreadResponse> {
    this.mustGet(threadId);
    const provider = this.provider(this.threadProvider(threadId));
    assertProviderOperation(this.threadProvider(threadId), provider.capabilities, "archive");
    if (!provider.archiveThread) throw new UnsupportedProviderOperationError(this.threadProvider(threadId), "archive");
    await provider.archiveThread(threadId);
    return { ok: true };
  }

  async unarchiveThread(threadId: string): Promise<UnarchiveThreadResponse> {
    const provider = this.provider(this.threadProvider(threadId));
    assertProviderOperation(this.threadProvider(threadId), provider.capabilities, "unarchive");
    if (!provider.unarchiveThread) throw new UnsupportedProviderOperationError(this.threadProvider(threadId), "unarchive");
    await provider.unarchiveThread(threadId);
    return { ok: true };
  }

  async compactThread(threadId: string): Promise<CompactThreadResponse> {
    this.assertAdmitting();
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
    const provider = request.threadId ? this.threadProvider(request.threadId, request.provider) : request.provider ?? this.defaultProvider();
    // A conversation's catalog comes from its session when it has one; otherwise discovery is provider-wide.
    const session = request.threadId ? this.mustGet(request.threadId).session : undefined;
    const catalog = session?.listModels ? session : this.provider(provider);
    assertProviderOperation(provider, catalog.capabilities, "modelCatalog");
    if (!catalog.listModels) throw new UnsupportedProviderOperationError(provider, "modelCatalog");
    return catalog.listModels(request);
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
      ? await this.resolveModel(this.threadProvider(threadId), model, this.mustGet(threadId).session, false, threadId)
      : null;
    const state = this.effortStateByThread.get(threadId);
    return {
      threadId, model: entry?.id ?? model ?? null, effortOptionsKnown: entry?.supportedEfforts != null,
      currentEffort: state?.current ?? null, pendingEffort: state?.pending ?? null, pendingEffortClear: state?.pendingClear ?? false,
      inputModalities: entry?.inputModalities ?? null,
      defaultEffort: entry?.defaultEffort ?? null, supportedEfforts: entry?.supportedEfforts ?? null,
    };
  }

  private async resolveModel(provider: AgentProvider, model: string | null | undefined, session?: ProviderSession, strict = false, threadId?: string): Promise<ModelSummary | null> {
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const request = { cursor, limit: 100, includeHidden: true, provider, ...(threadId ? { threadId } : {}) };
      let result: ListModelsResponse;
      try { result = session?.listModels ? await session.listModels(request) : await this.listModels(request); }
      catch (error) { if (!strict) return null; throw error; }
      const entry = result.data.find((entry) => model ? entry.id === model : entry.isDefault);
      if (entry) return entry;
      if (!result.nextCursor || seen.has(result.nextCursor)) break;
      seen.add(result.nextCursor);
      cursor = result.nextCursor;
    } while (true);
    if (!strict) return null;
    throw new ApplicationActionError({ code: "model_unavailable" });
  }

  private assertModelEffort(model: ModelSummary, effort: string | null | undefined): void {
    if (effort && model.supportedEfforts !== null && !model.supportedEfforts.some(option => option.value === effort)) {
      throw new ApplicationActionError({ code: "unsupported_effort", model: model.id, requested: effort, available: model.supportedEfforts.map(option => option.value) });
    }
  }

  private assertModelInput(model: ModelSummary, input: readonly import("../../../shared/protocol/user_input.js").UserInput[]): void {
    const modality = unsupportedModelInput(model, input);
    if (modality) throw new UnsupportedModelInputError(model.id, modality);
  }

  async setThreadEffort(threadId: string, requested: EffortSelection): Promise<ThreadEffortState> {
    this.requireCapability(threadId, "effortSelection");
    const state = await this.getThreadEffort(threadId);
    const effort = requested === null ? null : typeof requested === "string" ? requested : state.defaultEffort;
    if (requested !== null && (!effort || (state.effortOptionsKnown !== false && !state.supportedEfforts?.some((option) => option.value === effort)))) {
      throw new ApplicationActionError({ code: "unsupported_effort", model: state.model, requested: typeof requested === "string" ? requested : "model default", available: state.supportedEfforts?.map((option) => option.value) ?? [] });
    }
    this.effortStateByThread.set(threadId, { current: state.currentEffort, pending: effort, pendingClear: effort === null });
    return { ...state, pendingEffort: effort, pendingEffortClear: effort === null };
  }

  async listSkills(threadId: string, request: SkillsListRequest): Promise<SkillsListResponse> {
    this.requireCapability(threadId, "skills");
    const managed = this.mustGet(threadId);
    const workspacePath = await this.resolveThreadCwd(threadId);
    if (!managed.session.listSkills) throw new UnsupportedProviderOperationError(this.threadProvider(threadId), "skills");
    const { skills, errors } = await managed.session.listSkills({ refresh: request.refresh, workspacePath });
    return { workspacePath, skills, errors };
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
    listener: (event: import("../../../shared/protocol/events.js").BridgeEvent) => void,
    cursorOrOptions?: string | { afterId?: string; replay?: boolean },
  ): () => void {
    const managed = this.mustGet(threadId);
    return this.applicationEvents.get(managed.session)!.subscribe(listener, cursorOrOptions);
  }

  async submitTurn(threadId: string, request: SubmitTurnRequest): Promise<SubmitTurnResponse> {
    this.assertAdmitting();
    const managed = this.mustGet(threadId);
    assertInputSupport(this.threadProvider(threadId), managed.session.capabilities, request.input);
    const modelState = this.modelStateByThread.get(threadId);
    const model = request.model ?? modelState?.pendingModel ?? undefined;
    const effortState = this.effortStateByThread.get(threadId);
    let effort: string | null | undefined = request.effort !== undefined ? request.effort : effortState?.pendingClear ? null : effortState?.pending ?? undefined;
    if (model) this.requireCapability(threadId, "modelSelection");
    if (effort || request.effort === null || effortState?.pendingClear) this.requireCapability(threadId, "effortSelection");
    if (managed.session.capabilities.modelCatalog) {
      const selected = await this.resolveModel(this.threadProvider(threadId), model ?? modelState?.currentModel, managed.session,
        !!model && managed.session.capabilities.modelCatalogAuthoritative === true, threadId);
      if (selected) this.assertModelInput(selected, request.input);
      if (managed.session.capabilities.effortSelection && selected && selected.supportedEfforts !== null && effort === undefined && effortState?.current && !selected.supportedEfforts.some(option => option.value === effortState.current)) {
        // Preserve inherited effort only while the selected model supports it.
        effort = selected.defaultEffort;
      }
      if (selected) this.assertModelEffort(selected, effort);
    }
    // The adapter reports the settings it applied with `thread.settings.changed`, which settles
    // pending selections; a failed start leaves them pending and retryable.
    const turnId = await managed.session.startTurn(request.input, {
      ...(model ? { model } : {}), ...(effort !== undefined ? { effort } : {}),
    });
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
      const model = await this.resolveModel(this.threadProvider(threadId), this.modelStateByThread.get(threadId)?.currentModel, managed.session, false, threadId);
      if (model) this.assertModelInput(model, request.input);
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
    const { approval, nativeApprovalId } = this.approvals.markDecided(threadId, approvalId, decision, managed.session.sessionId);

    const threadSession = managed.session;
    const events = this.applicationEvents.get(threadSession)!;
    events.publish({
      id: `${threadSession.sessionId}:approval-decided:${approvalId}`,
      type: "approval.decided",
      threadId,
      sessionId: threadSession.sessionId,
      ts: new Date().toISOString(),
      payload: { approvalId, decision: decision.decision, state: approval.status },
    });

    try {
      await managed.session.applyApprovalDecision(nativeApprovalId, decision);
      this.approvals.markApplied(threadId, approvalId);
      events.publish({
        id: `${threadSession.sessionId}:approval-applied:${approvalId}`,
        type: "approval.applied",
        threadId,
        sessionId: threadSession.sessionId,
        ts: new Date().toISOString(),
        payload: { approvalId },
      });
    } catch (error) {
      this.approvals.markFailed(threadId, approvalId);
      events.publish({
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
    this.runtimeByThread.clear();
  }

  /** Pauses new turns until resumed. Running turns, steering, interrupts and approvals continue. */
  pauseNewTurns(): void { this.newTurnsPaused = true; }
  resumeNewTurns(): void { this.newTurnsPaused = false; }

  private assertAdmitting(): void {
    if (this.newTurnsPaused) throw new ApplicationActionError({ code: "restart_pending" });
  }

  private assertRunning(): void {
    if (this.stopped) throw new Error("Session manager is stopped.");
  }

  private defaultProvider(): string {
    if (!this.providers.includes(this.fallbackProvider)) throw new Error("No default agent provider is registered.");
    return this.fallbackProvider;
  }

  private allocateSession(provider: AgentProvider = this.defaultProvider()): ProviderSession {
    this.assertRunning();
    const session = this.provider(provider).openSession(this.dynamicTools);
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
        this.sessionTurns.delete(session);
      }
    }
  }

  private attachSessionSubscriptions(session: ProviderSession): void {
    const events = new EventBus();
    const rejectedQuestions = new Set<string>();
    const seenRequests = new Set<string>();
    const nativeRequests = new Map<string, Array<string | null>>();
    this.applicationEvents.set(session, events);
    this.sessionSubscriptions.set(session, session.eventBus.subscribe((event) => {
      this.learn(session, event);
      if (event.type !== "approval.requested" && event.type.startsWith("approval.") && "approvalId" in event.payload && rejectedQuestions.has(event.payload.approvalId)) return;
      if (event.type === "approval.requested") {
        const requestKey = JSON.stringify([event.threadId, event.id]);
        if (seenRequests.has(requestKey)) return;
        seenRequests.add(requestKey);
        const nativeKey = JSON.stringify([event.threadId, event.payload.approvalId]);
        nativeRequests.set(nativeKey, [...nativeRequests.get(nativeKey) ?? [], event.payload.userInput?.turnId ?? this.sessionTurns.get(session) ?? null]);
        rejectedQuestions.delete(event.payload.approvalId);
        if (event.payload.kind === "question" && !session.capabilities.questions) {
          const { approvalId, choices } = event.payload;
          const failureId = randomUUID();
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
              const turnId = this.sessionTurns.get(session) ?? null;
              if (turnId) events.publish({ ...event, id: `${event.id}:turn-failed`, type: "turn.failed", payload: { turnId, message } });
              events.publish({ ...event, id: `${event.id}:session-error`, type: "session.error", payload: { message } });
              for (const [threadId, managed] of this.sessionsByThread) if (managed.session === session) this.discardThreadSession(threadId);
              this.releaseSession(session);
            }
            events.publish({ ...event, id: `${event.id}:rejected`, type: "approval.failed", payload: { approvalId: failureId, message } });
          });
          return;
        }
        const pendingBefore = this.approvals.listByThread(event.threadId).filter(approval => approval.status === "pending");
        const approval = this.approvals.create(event.payload as ApprovalRequestPayload, {
          threadId: event.threadId,
          sessionId: session.sessionId,
          requestEventId: event.id,
          turnId: event.payload.userInput?.turnId ?? this.sessionTurns.get(session) ?? null,
        });
        const retired = this.approvals.listByThread(event.threadId).filter(approval => approval.status === "expired" && pendingBefore.some(previous => previous.approvalId === approval.approvalId));
        for (const previous of retired) events.publish({ ...event, id: `${event.id}:expired:${previous.approvalId}`, type: "approval.expired", payload: { approvalId: previous.approvalId } });
        events.publish({ ...event, payload: { ...event.payload, approvalId: approval.approvalId } });
        return;
      }

      if (event.type.startsWith("approval.") && "approvalId" in event.payload) {
        const turnId = "turnId" in event.payload ? event.payload.turnId : undefined;
        const requestEventId = "requestEventId" in event.payload ? event.payload.requestEventId : undefined;
        const occurrences = nativeRequests.get(JSON.stringify([event.threadId, event.payload.approvalId])) ?? [];
        if (requestEventId === undefined && occurrences.filter(owner => turnId == null || owner === turnId).length !== 1) return;
        const approval = this.approvals.resolveNative(event.threadId, session.sessionId, event.payload.approvalId, turnId, requestEventId);
        if (!approval) return;
        event = { ...event, payload: { ...event.payload, approvalId: approval.approvalId } } as BridgeEvent;
        if (event.type === "approval.expired" && approval.status === "pending") this.approvals.markExpired(event.threadId, approval.approvalId);
      }

      if (event.type === "turn.completed" || event.type === "turn.failed") {
        for (const approval of this.approvals.expireTurn(event.threadId, session.sessionId, event.payload.turnId)) {
          events.publish({ ...event, id: `${event.id}:expired:${approval.approvalId}`, type: "approval.expired", payload: { approvalId: approval.approvalId } });
        }
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
        else this.tokenUsageByThread.delete(event.threadId);
      }
      events.publish(event);
    }, { replay: false }));
  }

  /** Thread state comes from the adapter's events, never from its fields. */
  private learn(session: ProviderSession, event: BridgeEvent): void {
    const runtime = this.runtimeByThread.get(event.threadId);
    if (event.type === "turn.started") {
      this.sessionTurns.set(session, event.payload.turnId);
      if (runtime) runtime.activeTurnId = event.payload.turnId;
    }
    if (event.type === "turn.completed" || event.type === "turn.failed") {
      // A delayed end of an earlier turn does not end the current one.
      if (event.payload.turnId === null || event.payload.turnId === this.sessionTurns.get(session)) this.sessionTurns.set(session, null);
      if (runtime && (event.payload.turnId === null || event.payload.turnId === runtime.activeTurnId)) runtime.activeTurnId = null;
    }
    if (event.type === "thread.status.changed" && runtime) runtime.backgroundTaskCount = event.payload.status.backgroundTaskCount;
    if (event.type === "thread.settings.changed") {
      const { model, effort, cwd, profile } = event.payload;
      if (runtime) runtime.profile = profile;
      if (this.sessionsByThread.has(event.threadId)) this.cwdByThread.set(event.threadId, cwd);
      const models = this.modelStateByThread.get(event.threadId);
      if (models) this.modelStateByThread.set(event.threadId, { currentModel: model, pendingModel: models.pendingModel === model ? null : models.pendingModel });
      const efforts = this.effortStateByThread.get(event.threadId);
      if (efforts) this.effortStateByThread.set(event.threadId, {
        current: effort,
        pending: efforts.pending !== null && efforts.pending === effort ? null : efforts.pending,
        pendingClear: efforts.pendingClear && effort !== null,
      });
    }
  }

  private runtime(threadId: string): ThreadRuntime {
    this.mustGet(threadId);
    return this.runtimeByThread.get(threadId) ?? { activeTurnId: null, backgroundTaskCount: 0, profile: null };
  }

  /** Release an unusable session without deleting its provider history or workspace. */
  private discardThreadSession(threadId: string): void {
    this.sessionsByThread.delete(threadId);
    this.cwdByThread.delete(threadId);
    this.tokenUsageByThread.delete(threadId);
    this.effortStateByThread.delete(threadId);
    this.modelStateByThread.delete(threadId);
    this.runtimeByThread.delete(threadId);
    for (const approval of this.approvals.listByThread(threadId)) if (approval.status === "pending") this.approvals.markExpired(threadId, approval.approvalId);
  }

  getThreadProvider(threadId: string): AgentProvider { return this.threadProvider(threadId); }

  private threadProvider(threadId: string, requested?: AgentProvider): AgentProvider {
    const provider = this.providerDirectory.resolve(threadId);
    if (requested && requested !== provider) throw new Error("Cannot change the provider of an existing thread.");
    return provider;
  }

  private provider(provider: AgentProvider): Provider {
    this.assertRunning();
    return this.providerFor(provider);
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

    const raw = await this.provider(this.threadProvider(threadId)).readThread(threadId, false);
    const thread = raw.thread;
    const cwd = asString(thread.cwd);
    if (!cwd) {
      throw new ApplicationActionError({ code: "workspace_unavailable" });
    }
    if (this.sessionsByThread.has(threadId)) this.cwdByThread.set(threadId, cwd);
    return cwd;
  }
}
