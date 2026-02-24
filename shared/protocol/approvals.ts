export type ApprovalState = "pending" | "approved" | "rejected" | "expired" | "applied" | "failed";

export interface ApprovalChoice {
  value: string;
  label: string;
}

export interface ApprovalRequestPayload {
  approvalId: string;
  method: string;
  prompt: string;
  choices: ApprovalChoice[];
  params: unknown;
}

export interface ApprovalDecisionRequest {
  decision: string;
  reason?: string;
}

export interface ApprovalRecord extends ApprovalRequestPayload {
  threadId: string;
  sessionId: string;
  status: ApprovalState;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  decisionBy?: string;
  decisionReason?: string;
}

export function isApprovalState(value: string): value is ApprovalState {
  return (
    value === "pending" ||
    value === "approved" ||
    value === "rejected" ||
    value === "expired" ||
    value === "applied" ||
    value === "failed"
  );
}
