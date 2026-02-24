import type {
  ApprovalDecisionApiRequest,
  ApprovalPolicy,
  CreateThreadRequest,
  InterruptTurnRequest,
  SubmitTurnRequest,
} from "./requests.js";

const APPROVAL_POLICIES: ApprovalPolicy[] = ["untrusted", "on-failure", "on-request", "never"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

export function validateCreateThreadRequest(value: unknown): CreateThreadRequest {
  if (!isRecord(value) || typeof value.approvalPolicy !== "string") {
    throw new Error("Invalid create thread payload.");
  }
  if (!APPROVAL_POLICIES.includes(value.approvalPolicy as ApprovalPolicy)) {
    throw new Error("Invalid approval policy.");
  }
  return { approvalPolicy: value.approvalPolicy as ApprovalPolicy };
}

export function validateSubmitTurnRequest(value: unknown): SubmitTurnRequest {
  if (!isRecord(value) || typeof value.input !== "string" || !value.input.trim()) {
    throw new Error("Invalid turn payload.");
  }
  if (value.approvalPolicy && !APPROVAL_POLICIES.includes(value.approvalPolicy as ApprovalPolicy)) {
    throw new Error("Invalid approval policy.");
  }
  return {
    input: value.input.trim(),
    approvalPolicy: value.approvalPolicy as ApprovalPolicy | undefined,
  };
}

export function validateInterruptTurnRequest(value: unknown): InterruptTurnRequest {
  if (!isRecord(value)) {
    return {};
  }
  if (value.turnId !== undefined && typeof value.turnId !== "string") {
    throw new Error("Invalid turn id.");
  }
  return { turnId: value.turnId as string | undefined };
}

export function validateApprovalDecisionRequest(value: unknown): ApprovalDecisionApiRequest {
  if (!isRecord(value) || typeof value.decision !== "string" || !value.decision.trim()) {
    throw new Error("Invalid approval decision payload.");
  }
  if (value.reason !== undefined && typeof value.reason !== "string") {
    throw new Error("Invalid approval decision reason.");
  }
  return {
    decision: value.decision.trim(),
    reason: typeof value.reason === "string" ? value.reason.trim() : undefined,
  };
}
