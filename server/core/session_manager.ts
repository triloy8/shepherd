import type {
  ApprovalDecisionRequest,
  ApprovalRecord,
  ApprovalRequestPayload,
} from "../../shared/protocol/approvals.js";
import type {
  ApprovalPolicy,
  ArchiveThreadResponse,
  CompactThreadResponse,
  CreateThreadResponse,
  ForkThreadRequest,
  ForkThreadResponse,
  GetThreadStateResponse,
  ListLoadedThreadsRequest,
  ListLoadedThreadsResponse,
  ListStoredThreadsRequest,
  ListStoredThreadsResponse,
  ListThreadsResponse,
  ReadThreadRequest,
  ReadThreadResponse,
  ResumeThreadRequest,
  ResumeThreadResponse,
  RollbackThreadRequest,
  RollbackThreadResponse,
  SetThreadNameRequest,
  SubmitTurnRequest,
  SubmitTurnResponse,
  UnarchiveThreadResponse,
} from "../../shared/protocol/requests.js";
import { ApprovalsStore } from "./approvals.js";
import { CodexSession } from "./codex_session.js";

interface ManagedSession {
  session: CodexSession;
  createdAt: string;
}

type ThreadListRawResponse = {
  data?: unknown;
  nextCursor?: unknown;
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

function toBoolean(value: unknown): boolean {
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (record.type === "notLoaded") return true;
  }
  return false;
}

function extractThreadSummary(value: unknown) {
  const record = asRecord(value);
  return {
    threadId: asString(record.id) ?? "unknown",
    name: asString(record.name),
    preview: asString(record.preview) ?? "",
    archived: toBoolean(record.status),
    createdAt: asNumber(record.createdAt),
    updatedAt: asNumber(record.updatedAt),
    source: asString(asRecord(record.source).kind) ?? asString(record.source),
    cwd: asString(record.cwd),
  };
}

export class SessionManager {
  private sessionsByThread = new Map<string, ManagedSession>();
  private approvals = new ApprovalsStore();
  private controlSession: CodexSession | null = null;

  async createThread(approvalPolicy: ApprovalPolicy): Promise<CreateThreadResponse> {
    const managed = await this.createManagedSession(approvalPolicy);
    const threadId = await managed.session.startThread(approvalPolicy);
    this.sessionsByThread.set(threadId, managed);
    return { threadId, sessionId: managed.session.sessionId };
  }

  async resumeThread(threadId: string, request: ResumeThreadRequest): Promise<ResumeThreadResponse> {
    const existing = this.sessionsByThread.get(threadId);
    if (existing) {
      return { threadId, sessionId: existing.session.sessionId };
    }

    const approvalPolicy = request.approvalPolicy ?? "on-request";
    const managed = await this.createManagedSession(approvalPolicy);
    const resumedThreadId = await managed.session.resumeThread(threadId, request.approvalPolicy);
    this.sessionsByThread.set(resumedThreadId, managed);
    return { threadId: resumedThreadId, sessionId: managed.session.sessionId };
  }

  async forkThread(threadId: string, request: ForkThreadRequest): Promise<ForkThreadResponse> {
    const approvalPolicy = request.approvalPolicy ?? "on-request";
    const managed = await this.createManagedSession(approvalPolicy);
    const forkedThreadId = await managed.session.forkThread(threadId, request.approvalPolicy);
    this.sessionsByThread.set(forkedThreadId, managed);
    return { threadId: forkedThreadId, sessionId: managed.session.sessionId };
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

  async listStoredThreads(request: ListStoredThreadsRequest): Promise<ListStoredThreadsResponse> {
    const session = await this.getControlSession();
    const raw = (await session.listStoredThreads(request)) as ThreadListRawResponse;
    const data = Array.isArray(raw.data) ? raw.data : [];
    return {
      threads: data.map(extractThreadSummary).filter((entry) => entry.threadId !== "unknown"),
      nextCursor: asString(raw.nextCursor),
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
    const session = await this.getSessionForThread(threadId);
    const raw = asRecord(await session.readThread(threadId, request.includeTurns ?? false));
    if (!raw.thread) {
      throw new Error(`Failed to read thread ${threadId}.`);
    }
    return { thread: raw.thread };
  }

  async setThreadName(threadId: string, request: SetThreadNameRequest): Promise<{ ok: true }> {
    const session = await this.getSessionForThread(threadId);
    await session.setThreadName(threadId, request.name);
    return { ok: true };
  }

  async archiveThread(threadId: string): Promise<ArchiveThreadResponse> {
    const session = await this.getSessionForThread(threadId);
    await session.archiveThread(threadId);
    return { ok: true };
  }

  async unarchiveThread(threadId: string): Promise<UnarchiveThreadResponse> {
    const session = await this.getSessionForThread(threadId);
    await session.unarchiveThread(threadId);
    return { ok: true };
  }

  async compactThread(threadId: string): Promise<CompactThreadResponse> {
    const session = await this.getSessionForThread(threadId);
    await session.compactThread(threadId);
    return { ok: true };
  }

  async rollbackThread(threadId: string, request: RollbackThreadRequest): Promise<RollbackThreadResponse> {
    const session = await this.getSessionForThread(threadId);
    const raw = asRecord(await session.rollbackThread(threadId, request.numTurns));
    if (!raw.thread) {
      throw new Error("Rollback did not return updated thread state.");
    }
    return { thread: raw.thread };
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
    const turnId = await managed.session.startTurn(request.input, request.approvalPolicy);
    return { ok: true, turnId };
  }

  async interruptTurn(threadId: string, turnId?: string): Promise<void> {
    const managed = this.mustGet(threadId);
    await managed.session.interruptTurn(turnId);
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
    this.controlSession?.stop();
    this.controlSession = null;
  }

  private async createManagedSession(approvalPolicy: ApprovalPolicy): Promise<ManagedSession> {
    const session = new CodexSession(approvalPolicy);
    this.attachApprovalSubscription(session);
    return {
      session,
      createdAt: new Date().toISOString(),
    };
  }

  private attachApprovalSubscription(session: CodexSession): void {
    session.eventBus.subscribe((event) => {
      if (event.type !== "approval.requested") return;
      this.approvals.create(event.payload as ApprovalRequestPayload, {
        threadId: event.threadId,
        sessionId: session.sessionId,
      });
    });
  }

  private async getControlSession(): Promise<CodexSession> {
    if (this.controlSession) return this.controlSession;
    const session = new CodexSession("on-request");
    this.attachApprovalSubscription(session);
    await session.initialize();
    this.controlSession = session;
    return session;
  }

  private async getSessionForThread(threadId: string): Promise<CodexSession> {
    const loaded = this.sessionsByThread.get(threadId);
    if (loaded) return loaded.session;
    return this.getControlSession();
  }

  private mustGet(threadId: string): ManagedSession {
    const managed = this.sessionsByThread.get(threadId);
    if (!managed) {
      throw new Error(`Unknown thread ${threadId}.`);
    }
    return managed;
  }
}
