import { randomUUID } from "node:crypto";
import { validateUserQuestionAnswers } from "../../../shared/protocol/user_questions.js";
import type {
  ApprovalDecisionRequest,
  ApprovalRecord,
  ApprovalRequestPayload,
  ApprovalState,
} from "../../../shared/protocol/approvals.js";

export class ApprovalDecisionError extends Error {
  constructor(readonly code: "approval_not_found" | "approval_decided" | "invalid_decision", message: string) {
    super(message);
  }
}

type StoredApproval = ApprovalRecord & {
  internalId: string;
  requestEventId?: string;
  turnId: string | null;
};

export class ApprovalsStore {
  private approvals = new Map<string, StoredApproval>();
  private key(threadId: string, approvalId: string): string { return JSON.stringify([threadId, approvalId]); }

  create(
    request: ApprovalRequestPayload,
    context: { threadId: string; sessionId: string; turnId?: string | null; requestEventId?: string },
  ): ApprovalRecord {
    const now = new Date().toISOString();
    const approval: StoredApproval = {
      ...structuredClone(request),
      approvalId: randomUUID(),
      threadId: context.threadId,
      sessionId: context.sessionId,
      status: "pending",
      createdAt: now,
      updatedAt: now,
      internalId: request.approvalId,
      requestEventId: context.requestEventId,
      turnId: request.userInput?.turnId ?? context.turnId ?? null,
    };
    // A reused native ID retires its previous occurrence; clients retain the old handle.
    for (const previous of this.approvals.values()) {
      if (previous.threadId === context.threadId && previous.sessionId === context.sessionId && previous.internalId === request.approvalId && previous.status === "pending") this.markExpired(previous.threadId, previous.approvalId);
    }
    this.approvals.set(this.key(context.threadId, approval.approvalId), approval);
    return this.toPublicRecord(approval);
  }

  /** Uncorrelated follow-ups are safe only when a native identity has one occurrence. */
  resolveNative(threadId: string, sessionId: string, nativeId: string, turnId?: string | null, requestEventId?: string): ApprovalRecord | null {
    const matches = [...this.approvals.values()].filter(approval => approval.threadId === threadId && approval.sessionId === sessionId && approval.internalId === nativeId && (requestEventId !== undefined ? approval.requestEventId === requestEventId : turnId == null || approval.turnId === turnId));
    return matches.length === 1 ? this.toPublicRecord(matches[0]!) : null;
  }

  listByThread(threadId: string): ApprovalRecord[] {
    return [...this.approvals.values()]
      .filter((approval) => approval.threadId === threadId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((approval) => this.toPublicRecord(approval));
  }

  listPending(): ApprovalRecord[] {
    return [...this.approvals.values()]
      .filter((approval) => approval.status === "pending")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((approval) => this.toPublicRecord(approval));
  }

  markDecided(
    threadId: string,
    approvalId: string,
    payload: ApprovalDecisionRequest,
    sessionId?: string,
  ): { approval: ApprovalRecord; nativeApprovalId: string } {
    const approval = this.getStoredApproval(threadId, approvalId);
    if (sessionId !== undefined && approval.sessionId !== sessionId) throw new ApprovalDecisionError("approval_decided", "This approval belongs to an earlier session.");
    if (approval.status !== "pending") {
      throw new ApprovalDecisionError("approval_decided", `Approval ${approvalId} is already ${approval.status}.`);
    }

    const choice = approval.choices.find(choice => choice.value === payload.decision);
    if (!choice) {
      throw new ApprovalDecisionError("invalid_decision", "Decision must match one of the approval choices.");
    }
    if (approval.userInput && choice.intent === "answer") {
      try { validateUserQuestionAnswers(approval.userInput.questions, payload.answers); }
      catch (error) { throw new ApprovalDecisionError("invalid_decision", (error as Error).message); }
    }
    approval.status = choice.intent === "allow" || choice.intent === "answer" ? "approved" : "rejected";
    approval.updatedAt = new Date().toISOString();
    approval.decisionReason = payload.reason;
    return { approval: this.toPublicRecord(approval), nativeApprovalId: approval.internalId };
  }

  expireUserInput(threadId: string, turnId?: string): ApprovalRecord[] {
    return this.listByThread(threadId).filter(a => a.status === "pending" && a.userInput && (!turnId || a.userInput.turnId === turnId))
      .map(a => this.transition(threadId, a.approvalId, "expired"));
  }

  /** Unknown turn ownership is retired with the thread's terminal event; known newer turns survive late events. */
  expireTurn(threadId: string, sessionId: string, turnId: string | null): ApprovalRecord[] {
    return [...this.approvals.values()]
      .filter(a => a.threadId === threadId && a.sessionId === sessionId && a.status === "pending" &&
        (turnId === null || a.turnId === null || a.turnId === turnId))
      .map(a => this.transition(threadId, a.approvalId, "expired"));
  }

  markExpired(threadId: string, approvalId: string): ApprovalRecord {
    return this.transition(threadId, approvalId, "expired");
  }

  markApplied(threadId: string, approvalId: string): ApprovalRecord {
    return this.transition(threadId, approvalId, "applied");
  }

  markFailed(threadId: string, approvalId: string): ApprovalRecord {
    return this.transition(threadId, approvalId, "failed");
  }

  private transition(threadId: string, approvalId: string, state: ApprovalState): ApprovalRecord {
    const approval = this.getStoredApproval(threadId, approvalId);
    approval.status = state;
    approval.updatedAt = new Date().toISOString();
    return this.toPublicRecord(approval);
  }

  private getStoredApproval(threadId: string, approvalId: string): StoredApproval {
    const approval = this.approvals.get(this.key(threadId, approvalId));
    if (!approval || approval.threadId !== threadId) {
      throw new ApprovalDecisionError("approval_not_found", `Approval ${approvalId} not found for thread ${threadId}.`);
    }
    return approval;
  }

  private toPublicRecord(approval: StoredApproval): ApprovalRecord {
    const { internalId: _internalId, turnId: _turnId, requestEventId: _requestEventId, ...rest } = approval;
    return rest;
  }
}
