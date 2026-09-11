import type {
  ApprovalDecisionRequest,
  ApprovalRecord,
  ApprovalRequestPayload,
} from "../../shared/protocol/approvals.js";
import type { ThreadTokenUsageUpdatedEvent } from "../../shared/protocol/events.js";
import type {
  ApprovalPolicy,
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
  RollbackThreadRequest,
  RollbackThreadResponse,
  SetThreadNameRequest,
  SkillsConfigWriteRequest,
  SkillsConfigWriteResponse,
  SkillsListRequest,
  SkillsListResponse,
  SteerTurnRequest,
  SteerTurnResponse,
  SubmitTurnRequest,
  SubmitTurnResponse,
  ThreadRecord,
  ThreadTokenUsage,
  UnarchiveThreadResponse,
} from "../../shared/protocol/requests.js";
import { ApprovalsStore } from "./approvals.js";
import { CodexSession } from "./codex_session.js";
import { DynamicToolRegistry } from "./dynamic_tool_registry.js";

interface ManagedSession {
  session: CodexSession;
  createdAt: string;
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

type ThreadListRawResponse = {
  data?: ThreadRecord[];
  nextCursor?: unknown;
  backwardsCursor?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function extractThreadSummary(value: unknown, archived: boolean) {
  const record = asRecord(value);
  return {
    threadId: asString(record.id) ?? "unknown",
    name: asString(record.name),
    preview: asString(record.preview) ?? "",
    archived,
    createdAt: asNumber(record.createdAt),
    updatedAt: asNumber(record.updatedAt),
    source: asString(asRecord(record.source).kind) ?? asString(record.source),
    cwd: asString(record.cwd),
  };
}

function extractThreadRecord(value: unknown): ThreadRecord {
  const record = asRecord(value);
  const id = asString(record.id);
  if (!id) {
    throw new Error("Thread payload missing id.");
  }
  return {
    ...(record as ThreadRecord),
    id,
  };
}

export class SessionManager {
  private sessionsByThread = new Map<string, ManagedSession>();
  private approvals = new ApprovalsStore();
  private tokenUsageByThread = new Map<string, ThreadTokenUsage>();
  private cwdByThread = new Map<string, string>();
  private effortStateByThread = new Map<string, { current: string | null; pending: string | null }>();
  private modelStateByThread = new Map<string, ManagedModelState>();
  private controlSession: CodexSession | null = null;

  constructor(private readonly dynamicTools: DynamicToolRegistry = new DynamicToolRegistry()) {}

  async createThread(request: CreateThreadRequest): Promise<CreateThreadResponse> {
    const approvalPolicy = request.approvalPolicy ?? "on-request";
    const managed = await this.createManagedSession(approvalPolicy);
    const created = await managed.session.startThread(request);
    this.sessionsByThread.set(created.threadId, managed);
    if (request.cwd) {
      this.cwdByThread.set(created.threadId, request.cwd);
    }
    this.effortStateByThread.set(created.threadId, { current: created.reasoningEffort, pending: null });
    this.modelStateByThread.set(created.threadId, {
      currentModel: created.model,
      modelProvider: created.modelProvider,
      pendingModel: null,
    });
    return { threadId: created.threadId, sessionId: managed.session.sessionId };
  }

  async resumeThread(threadId: string, request: ResumeThreadRequest): Promise<ResumeThreadResponse> {
    const existing = this.sessionsByThread.get(threadId);
    if (existing) {
      return { threadId, sessionId: existing.session.sessionId };
    }

    const approvalPolicy = request.approvalPolicy ?? "on-request";
    const managed = await this.createManagedSession(approvalPolicy);
    const resumed = await managed.session.resumeThread(threadId, request);
    this.sessionsByThread.set(resumed.threadId, managed);
    if (request.cwd) {
      this.cwdByThread.set(resumed.threadId, request.cwd);
    }
    this.effortStateByThread.set(resumed.threadId, { current: resumed.reasoningEffort, pending: null });
    this.modelStateByThread.set(resumed.threadId, {
      currentModel: resumed.model,
      modelProvider: resumed.modelProvider,
      pendingModel: null,
    });
    return { threadId: resumed.threadId, sessionId: managed.session.sessionId };
  }

  async forkThread(threadId: string, request: ForkThreadRequest): Promise<ForkThreadResponse> {
    const approvalPolicy = request.approvalPolicy ?? "on-request";
    const managed = await this.createManagedSession(approvalPolicy);
    const forked = await managed.session.forkThread(threadId, request);
    this.sessionsByThread.set(forked.threadId, managed);
    if (request.cwd) {
      this.cwdByThread.set(forked.threadId, request.cwd);
    }
    this.effortStateByThread.set(forked.threadId, { current: forked.reasoningEffort, pending: null });
    this.modelStateByThread.set(forked.threadId, {
      currentModel: forked.model,
      modelProvider: forked.modelProvider,
      pendingModel: null,
    });
    return { threadId: forked.threadId, sessionId: managed.session.sessionId };
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
        .filter(([, managed]) => managed.session.activeTurnId !== null)
        .map(([threadId]) => threadId),
      pendingApprovalIds: this.approvals.listPending().map((approval) => approval.approvalId),
    };
  }

  async listStoredThreads(request: ListStoredThreadsRequest): Promise<ListStoredThreadsResponse> {
    const session = await this.getControlSession();
    const raw = (await session.listStoredThreads(request)) as ThreadListRawResponse;
    const data = Array.isArray(raw.data) ? raw.data : [];
    const archived = request.archived === true;
    return {
      threads: data.map((entry) => extractThreadSummary(entry, archived)).filter((entry) => entry.threadId !== "unknown"),
      nextCursor: asString(raw.nextCursor),
      backwardsCursor: asString(raw.backwardsCursor),
    };
  }

  async listLoadedThreads(request: ListLoadedThreadsRequest): Promise<ListLoadedThreadsResponse> {
    const session = await this.getControlSession();
    const raw = asRecord(await session.listLoadedThreads(request));
    const data = Array.isArray(raw.data) ? raw.data : [];
    return {
      threadIds: data.map((entry) => asString(entry)).filter((entry): entry is string => Boolean(entry)),
      nextCursor: asString(raw.nextCursor),
    };
  }

  getThreadState(threadId: string): GetThreadStateResponse {
    const managed = this.mustGet(threadId);
    return {
      threadId,
      sessionId: managed.session.sessionId,
      activeTurnId: managed.session.activeTurnId,
      approvalPolicy: managed.session.approvalPolicy,
    };
  }

  async readThread(threadId: string, request: ReadThreadRequest): Promise<ReadThreadResponse> {
    const session = this.mustGet(threadId).session;
    const raw = asRecord(await session.readThread(threadId, request.includeTurns ?? false));
    if (!raw.thread) {
      throw new Error(`Failed to read thread ${threadId}.`);
    }
    return { thread: extractThreadRecord(raw.thread) };
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
    const session = this.mustGet(threadId).session;
    await session.unarchiveThread(threadId);
    return { ok: true };
  }

  async compactThread(threadId: string): Promise<CompactThreadResponse> {
    const session = this.mustGet(threadId).session;
    await session.compactThread(threadId);
    return { ok: true };
  }

  async rollbackThread(threadId: string, request: RollbackThreadRequest): Promise<RollbackThreadResponse> {
    const session = this.mustGet(threadId).session;
    const raw = asRecord(await session.rollbackThread(threadId, request.numTurns));
    if (!raw.thread) {
      throw new Error("Rollback did not return updated thread state.");
    }
    return { thread: extractThreadRecord(raw.thread) };
  }

  async readAccountRateLimits(): Promise<AccountRateLimitsResponse> {
    const session = await this.getControlSession();
    const raw = asRecord(await session.readAccountRateLimits());
    return {
      rateLimits: raw.rateLimits ?? raw,
      rateLimitsByLimitId:
        raw.rateLimitsByLimitId && typeof raw.rateLimitsByLimitId === "object"
          ? (raw.rateLimitsByLimitId as Record<string, unknown>)
          : null,
      rateLimitResetCredits: raw.rateLimitResetCredits ?? null,
    };
  }

  async listModels(request: ListModelsRequest): Promise<ListModelsResponse> {
    const session = await this.getControlSession();
    const raw = asRecord(await session.listModels(request));
    const items = Array.isArray(raw.data) ? raw.data : [];
    return {
      data: items.map((item) => {
        const record = asRecord(item);
        return {
          id: asString(record.id) ?? asString(record.model) ?? "unknown",
          model: asString(record.model) ?? "unknown",
          displayName: asString(record.displayName) ?? asString(record.model) ?? "unknown",
          description: asString(record.description) ?? "",
          hidden: record.hidden === true,
          isDefault: record.isDefault === true,
          supportsPersonality: record.supportsPersonality === true,
          defaultReasoningEffort: asString(record.defaultReasoningEffort),
          supportedReasoningEfforts: (Array.isArray(record.supportedReasoningEfforts) ? record.supportedReasoningEfforts : [])
            .map((value) => {
              const option = asRecord(value);
              return { reasoningEffort: asString(option.reasoningEffort) ?? "", description: asString(option.description) ?? "" };
            }).filter((option) => option.reasoningEffort),

        };
      }),
      nextCursor: asString(raw.nextCursor),
    };
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
      const result = await this.listModels({ cursor, limit: 100, includeHidden: true });
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
    throw new Error("The thread's model is not in the model catalog. Use !model set <id> first.");
  }

  async setThreadEffort(threadId: string, requested: string): Promise<ThreadEffortState> {
    const state = await this.getThreadEffort(threadId);
    const effort = requested === "default" ? state.defaultEffort : requested;
    if (!effort || !state.supportedEfforts.some((option) => option.reasoningEffort === effort)) {
      throw new Error(`Unsupported effort for ${state.model}: ${requested}. Available: ${state.supportedEfforts.map((option) => option.reasoningEffort).join(", ") || "none"}.`);
    }
    this.effortStateByThread.set(threadId, { current: state.currentEffort, pending: effort });
    return { ...state, pendingEffort: effort };
  }

  async listSkills(threadId: string, request: SkillsListRequest): Promise<SkillsListResponse> {
    const managed = this.mustGet(threadId);
    const cwds = request.cwds ?? [await this.resolveThreadCwd(threadId)];
    return managed.session.listSkills({ ...request, cwds });
  }

  async getThreadCwd(threadId: string): Promise<string> {
    return this.resolveThreadCwd(threadId);
  }

  setThreadCwd(threadId: string, cwd: string): void {
    this.mustGet(threadId);
    this.cwdByThread.set(threadId, cwd);
  }

  async writeSkillConfig(
    threadId: string,
    request: SkillsConfigWriteRequest,
  ): Promise<SkillsConfigWriteResponse> {
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
    for (const managed of this.sessionsByThread.values()) {
      managed.session.stop();
    }
    this.sessionsByThread.clear();
    this.tokenUsageByThread.clear();
    this.cwdByThread.clear();
    this.modelStateByThread.clear();
    this.effortStateByThread.clear();
    this.controlSession?.stop();
    this.controlSession = null;
  }

  private async createManagedSession(approvalPolicy: ApprovalPolicy): Promise<ManagedSession> {
    const session = new CodexSession(approvalPolicy, this.dynamicTools);
    this.attachSessionSubscriptions(session);
    return {
      session,
      createdAt: new Date().toISOString(),
    };
  }

  private attachSessionSubscriptions(session: CodexSession): void {
    session.eventBus.subscribe((event) => {
      if (event.type === "approval.requested") {
        this.approvals.create(event.payload as ApprovalRequestPayload, {
          threadId: event.threadId,
          sessionId: session.sessionId,
        });
        return;
      }

      if (event.type === "thread.tokenUsage.updated") {
        const payload = event.payload as ThreadTokenUsageUpdatedEvent["payload"];
        if (!payload.tokenUsage) return;
        this.tokenUsageByThread.set(event.threadId, payload.tokenUsage);
      }
    });
  }

  private async getControlSession(): Promise<CodexSession> {
    if (this.controlSession) return this.controlSession;
    const session = new CodexSession("on-request", this.dynamicTools);
    this.attachSessionSubscriptions(session);
    await session.initialize();
    this.controlSession = session;
    return session;
  }

  private mustGet(threadId: string): ManagedSession {
    const managed = this.sessionsByThread.get(threadId);
    if (!managed) {
      throw new Error(`Unknown thread ${threadId}.`);
    }
    return managed;
  }

  private async resolveThreadCwd(threadId: string): Promise<string> {
    const cached = this.cwdByThread.get(threadId);
    if (cached) return cached;

    const session = this.mustGet(threadId).session;
    const raw = asRecord(await session.readThread(threadId, false));
    const thread = asRecord(raw.thread);
    const cwd = asString(thread.cwd);
    if (!cwd) {
      throw new Error(`Thread ${threadId} is missing cwd.`);
    }
    this.cwdByThread.set(threadId, cwd);
    return cwd;
  }
}
