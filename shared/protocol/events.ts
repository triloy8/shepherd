import type { ApprovalRecord, ApprovalRequestPayload } from "./approvals.js";

export type BridgeEventType =
  | "session.started"
  | "session.error"
  | "thread.started"
  | "turn.started"
  | "turn.completed"
  | "turn.failed"
  | "turn.stream.delta"
  | "turn.notification"
  | "approval.requested"
  | "approval.decided"
  | "approval.applied"
  | "approval.failed";

export interface BridgeEvent<TPayload = unknown> {
  id: string;
  type: BridgeEventType;
  threadId: string;
  sessionId: string;
  ts: string;
  payload: TPayload;
}

export type SessionStartedEvent = BridgeEvent<{ model: string }>;
export type SessionErrorEvent = BridgeEvent<{ message: string }>;
export type ThreadStartedEvent = BridgeEvent<{ approvalPolicy: string }>;
export type TurnStartedEvent = BridgeEvent<{ turnId: string | null }>;
export type TurnCompletedEvent = BridgeEvent<{ turnId: string | null }>;
export type TurnFailedEvent = BridgeEvent<{ message: string }>;
export type TurnStreamDeltaEvent = BridgeEvent<{ method: string; textDelta: string }>;
export type TurnNotificationEvent = BridgeEvent<{ method: string; params: unknown }>;
export type ApprovalRequestedEvent = BridgeEvent<ApprovalRequestPayload>;
export type ApprovalDecidedEvent = BridgeEvent<{ approvalId: string; decision: string; state: ApprovalRecord["status"] }>;
export type ApprovalAppliedEvent = BridgeEvent<{ approvalId: string }>;
export type ApprovalFailedEvent = BridgeEvent<{ approvalId: string; message: string }>;
