import type {
  ApprovalDecisionRequest,
  ApprovalRecord,
  ApprovalRequestPayload,
  ApprovalState,
} from "../../shared/protocol/approvals.js";

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

  markDecided(
    threadId: string,
    approvalId: string,
    payload: ApprovalDecisionRequest,
  ): { approval: ApprovalRecord } {
    const approval = this.getStoredApproval(threadId, approvalId);
    if (approval.status !== "pending") {
      throw new Error(`Approval ${approvalId} is already ${approval.status}.`);
    }

    approval.status = this.stateFromDecision(payload.decision);
    approval.updatedAt = new Date().toISOString();
    approval.decisionReason = payload.reason;
    return { approval: this.toPublicRecord(approval) };
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

  private stateFromDecision(decision: string): ApprovalState {
    const lowered = decision.toLowerCase();
    if (lowered.includes("accept") || lowered.includes("approve") || lowered === "success") {
      return "approved";
    }
    if (lowered.includes("decline") || lowered.includes("deny") || lowered.includes("reject") || lowered === "failure") {
      return "rejected";
    }
    return "rejected";
  }

  private getStoredApproval(threadId: string, approvalId: string): StoredApproval {
    const approval = this.approvals.get(approvalId);
    if (!approval || approval.threadId !== threadId) {
      throw new Error(`Approval ${approvalId} not found for thread ${threadId}.`);
    }
    return approval;
  }

  private toPublicRecord(approval: StoredApproval): ApprovalRecord {
    const { internalId: _internalId, ...rest } = approval;
    return rest;
  }
}
