import type { UserQuestionRequest, UserQuestionAnswers } from "./user_questions.js";

export type ApprovalState = "pending" | "approved" | "rejected" | "expired" | "applied" | "failed";

export interface ApprovalChoice {
  value: string;
  label: string;
  intent: "allow" | "deny" | "answer" | "cancel";
}

export interface ApprovalRequestPayload {
  approvalId: string;
  kind: "permission" | "question";
  prompt: string;
  choices: ApprovalChoice[];
  detail: string | null;
  userInput?: UserQuestionRequest;
}

export interface ApprovalDecisionRequest {
  decision: string;
  reason?: string;
  answers?: UserQuestionAnswers;
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
