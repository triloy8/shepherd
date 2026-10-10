import { validateUserQuestionAnswers } from "../../shared/protocol/user_questions.js";
import type {
  ApprovalDecisionRequest,
  ApprovalRecord,
  ApprovalRequestPayload,
  ApprovalState,
} from "../../shared/protocol/approvals.js";

export class ApprovalDecisionError extends Error {
  constructor(readonly code: "approval_not_found" | "approval_decided" | "invalid_decision", message: string) {
    super(message);
  }
}

interface StoredApproval extends ApprovalRecord {
  internalId: string;
}

export class ApprovalsStore {
  private approvals = new Map<string, StoredApproval>();

  create(
    request: ApprovalRequestPayload,
    context: { threadId: string; sessionId: string },
  ): ApprovalRecord {
    const now = new Date().toISOString();
    const approval: StoredApproval = {
      ...request,
      threadId: context.threadId,
      sessionId: context.sessionId,
      status: "pending",
      createdAt: now,
      updatedAt: now,
      internalId: request.approvalId,
    };
    this.approvals.set(request.approvalId, approval);
    return this.toPublicRecord(approval);
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
  ): { approval: ApprovalRecord } {
    const approval = this.getStoredApproval(threadId, approvalId);
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
    return { approval: this.toPublicRecord(approval) };
  }

  expireUserInput(threadId: string, turnId?: string): ApprovalRecord[] {
    return this.listByThread(threadId).filter(a => a.status === "pending" && a.userInput && (!turnId || a.userInput.turnId === turnId))
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
    const approval = this.approvals.get(approvalId);
    if (!approval || approval.threadId !== threadId) {
      throw new ApprovalDecisionError("approval_not_found", `Approval ${approvalId} not found for thread ${threadId}.`);
    }
    return approval;
  }

  private toPublicRecord(approval: StoredApproval): ApprovalRecord {
    const { internalId: _internalId, ...rest } = approval;
    return rest;
  }
}
