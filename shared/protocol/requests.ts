import type { ApprovalDecisionRequest, ApprovalRecord } from "./approvals.js";

export type ApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";

export interface CreateThreadRequest {
  approvalPolicy: ApprovalPolicy;
}

export interface CreateThreadResponse {
  threadId: string;
  sessionId: string;
}

export interface SubmitTurnRequest {
  input: string;
  approvalPolicy?: ApprovalPolicy;
}

export interface SubmitTurnResponse {
  ok: true;
  turnId: string | null;
}

export interface InterruptTurnRequest {
  turnId?: string;
}

export interface InterruptTurnResponse {
  ok: true;
}

export interface ListThreadsResponse {
  threads: Array<{ threadId: string; sessionId: string; createdAt: string }>;
}

export interface GetThreadStateResponse {
  threadId: string;
  sessionId: string;
  activeTurnId: string | null;
  approvalPolicy: ApprovalPolicy;
}

export interface ListApprovalsResponse {
  approvals: ApprovalRecord[];
}

export interface ApprovalDecisionApiRequest extends ApprovalDecisionRequest {}

export interface ApprovalDecisionApiResponse {
  ok: true;
}
