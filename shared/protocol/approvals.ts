import type { UserQuestionRequest, UserQuestionAnswers } from "./user_questions.js";
import type { Activity } from "./activity.js";

export type ApprovalState = "pending" | "approved" | "rejected" | "expired" | "applied" | "failed";

export interface ApprovalChoice {
  value: string;
  label: string;
  intent: "allow" | "deny" | "answer" | "cancel";
}

interface ApprovalRequestBase {
  /** Native at the provider boundary; an immutable occurrence handle in application records/events. */
  approvalId: string;
  choices: ApprovalChoice[];
}

/** A permission names the activity it would allow; surfaces write the prompt from it.
 * `reason` is the agent's own explanation, when it gives one. A question carries its form. */
export type ApprovalRequestPayload =
  | ApprovalRequestBase & { kind: "permission"; activity: Activity; reason: string | null; userInput?: undefined }
  | ApprovalRequestBase & { kind: "question"; userInput: UserQuestionRequest; activity?: undefined; reason?: undefined };

export interface ApprovalDecisionRequest {
  decision: string;
  reason?: string;
  answers?: UserQuestionAnswers;
}

export type ApprovalRecord = ApprovalRequestPayload & {
  threadId: string;
  sessionId: string;
  status: ApprovalState;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  decisionBy?: string;
  decisionReason?: string;
};

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
