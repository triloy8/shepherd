import type { ApprovalRecord, ApprovalRequestPayload } from "./approvals.js";
import type { ThreadTokenUsage } from "./requests.js";

export type BridgeEventType =
  | "session.started"
  | "session.error"
  | "session.limit.context"
  | "thread.started"
  | "thread.status.changed"
  | "thread.name.updated"
  | "thread.archived"
  | "thread.unarchived"
  | "thread.tokenUsage.updated"
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
export type SessionContextLimitEvent = BridgeEvent<{ message: string; method: string }>;
export type ThreadStartedEvent = BridgeEvent<{ approvalPolicy: string }>;
export type ThreadStatusChangedEvent = BridgeEvent<{ status: unknown }>;
export type ThreadNameUpdatedEvent = BridgeEvent<{ threadName: string | null }>;
export type ThreadArchivedEvent = BridgeEvent<Record<string, never>>;
export type ThreadUnarchivedEvent = BridgeEvent<Record<string, never>>;
export type ThreadTokenUsageUpdatedEvent = BridgeEvent<{ turnId: string | null; tokenUsage: ThreadTokenUsage | null }>;
export type TurnStartedEvent = BridgeEvent<{ turnId: string | null }>;
export type TurnCompletedEvent = BridgeEvent<{ turnId: string | null }>;
export type TurnFailedEvent = BridgeEvent<{ message: string }>;
export type TurnStreamDeltaEvent = BridgeEvent<{ method: string; textDelta: string }>;
export type TurnNotificationEvent = BridgeEvent<{ method: string; params: unknown }>;
export type ApprovalRequestedEvent = BridgeEvent<ApprovalRequestPayload>;
export type ApprovalDecidedEvent = BridgeEvent<{ approvalId: string; decision: string; state: ApprovalRecord["status"] }>;
export type ApprovalAppliedEvent = BridgeEvent<{ approvalId: string }>;
export type ApprovalFailedEvent = BridgeEvent<{ approvalId: string; message: string }>;
