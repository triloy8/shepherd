import type {
  ApprovalDecisionRequest,
  ApprovalRecord,
  ApprovalRequestPayload,
} from "../../shared/protocol/approvals.js";
import type { BridgeEvent } from "../../shared/protocol/events.js";
import type {
  ApprovalPolicy,
  CreateThreadResponse,
  GetThreadStateResponse,
  ListThreadsResponse,
  SubmitTurnRequest,
  SubmitTurnResponse,
} from "../../shared/protocol/requests.js";
import { ApprovalsStore } from "./approvals.js";
import { CodexSession } from "./codex_session.js";

interface ManagedSession {
  session: CodexSession;
  createdAt: string;
}

export class SessionManager {
  private sessionsByThread = new Map<string, ManagedSession>();
  private approvals = new ApprovalsStore();

  async createThread(approvalPolicy: ApprovalPolicy): Promise<CreateThreadResponse> {
    const session = new CodexSession(approvalPolicy);
    const threadId = await session.startThread(approvalPolicy);

    const managed: ManagedSession = {
      session,
      createdAt: new Date().toISOString(),
    };

    this.sessionsByThread.set(threadId, managed);

    session.eventBus.subscribe((event) => {
      if (event.type !== "approval.requested") return;
      this.approvals.create(event.payload as ApprovalRequestPayload, {
        threadId,
        sessionId: session.sessionId,
      });
    });

    return { threadId, sessionId: session.sessionId };
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

  getThreadState(threadId: string): GetThreadStateResponse {
    const managed = this.mustGet(threadId);
    return {
      threadId,
      sessionId: managed.session.sessionId,
      activeTurnId: managed.session.activeTurnId,
      approvalPolicy: managed.session.approvalPolicy,
    };
  }

  subscribeToThreadEvents(
    threadId: string,
    listener: (event: BridgeEvent) => void,
    lastEventId?: string,
  ): () => void {
    const managed = this.mustGet(threadId);
    return managed.session.eventBus.subscribe(listener, lastEventId);
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
  }

  private mustGet(threadId: string): ManagedSession {
    const managed = this.sessionsByThread.get(threadId);
    if (!managed) {
      throw new Error(`Unknown thread ${threadId}.`);
    }
    return managed;
  }
}
