import type { ApprovalPolicy } from "../../shared/protocol/requests.js";

export interface ServerRequestContext {
  requestId: string;
  method: string;
  params: unknown;
}

export interface SessionState {
  sessionId: string;
  threadId: string;
  approvalPolicy: ApprovalPolicy;
  activeTurnId: string | null;
  createdAt: string;
}
