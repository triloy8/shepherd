import type { ApprovalRecord, ApprovalRequestPayload } from "./approvals.js";
import type { ApprovalPolicy, ThreadTokenUsage } from "./requests.js";

export type MessagePhase = "commentary" | "final_answer";

export type TurnActivityKind =
  | "command"
  | "file_change"
  | "mcp_tool"
  | "dynamic_tool"
  | "web_search"
  | "collaboration"
  | "image"
  | "wait"
  | "other";

export type TurnActivityStatus = "started" | "completed" | "failed";

export interface BridgeEventPayloads {
  "session.started": { model: string };
  "session.error": { message: string };
  "session.limit.context": { message: string };
  "thread.started": { approvalPolicy: ApprovalPolicy };
  "thread.status.changed": { status: { state: "active" | "idle" | "error"; backgroundTaskCount: number } };
  "thread.name.updated": { threadName: string | null };
  "thread.archived": Record<string, never>;
  "thread.reverted": Record<string, never>;
  "thread.unarchived": Record<string, never>;
  "thread.tokenUsage.updated": { turnId: string | null; tokenUsage: ThreadTokenUsage | null };
  "turn.started": { turnId: string | null };
  "turn.completed": { turnId: string | null };
  "turn.failed": { message: string; turnId: string | null };
  "turn.stream.delta": {
    kind: "assistant_text" | "other";
    textDelta: string;
    itemId: string | null;
    phase: MessagePhase | null;
    turnId: string | null;
  };
  "turn.message.completed": {
    itemId: string;
    phase: MessagePhase | null;
    text: string;
    turnId: string | null;
  };
  "turn.image.generated": {
    itemId: string;
    turnId: string | null;
    path: string;
    revisedPrompt: string | null;
  };
  "turn.image.viewed": {
    itemId: string;
    turnId: string | null;
    path: string;
  };
  "turn.activity": {
    itemId: string | null;
    turnId: string | null;
    kind: TurnActivityKind;
    label: string;
    detail: string | null;
    status: TurnActivityStatus;
  };
  "approval.requested": ApprovalRequestPayload;
  "approval.decided": { approvalId: string; decision: string; state: ApprovalRecord["status"] };
  "approval.applied": { approvalId: string };
  "approval.failed": { approvalId: string; message: string };
  "approval.expired": { approvalId: string };
}

export type BridgeEventType = keyof BridgeEventPayloads;
export type BridgeEventOf<K extends BridgeEventType> = {
  id: string; type: K; threadId: string; sessionId: string; ts: string; payload: BridgeEventPayloads[K];
};
export type BridgeEvent = { [K in BridgeEventType]: BridgeEventOf<K> }[BridgeEventType];

/** Construct a correlated event; callers must supply the payload for its event name. */
export function bridgeEvent<K extends BridgeEventType>(event: BridgeEventOf<K>): BridgeEvent {
  return event as BridgeEvent;
}

export type SessionStartedEvent = BridgeEventOf<"session.started">;
export type SessionErrorEvent = BridgeEventOf<"session.error">;
export type SessionContextLimitEvent = BridgeEventOf<"session.limit.context">;
export type ThreadStartedEvent = BridgeEventOf<"thread.started">;
export type ThreadStatusChangedEvent = BridgeEventOf<"thread.status.changed">;
export type ThreadNameUpdatedEvent = BridgeEventOf<"thread.name.updated">;
export type ThreadArchivedEvent = BridgeEventOf<"thread.archived">;
export type ThreadRevertedEvent = BridgeEventOf<"thread.reverted">;
export type ThreadUnarchivedEvent = BridgeEventOf<"thread.unarchived">;
export type ThreadTokenUsageUpdatedEvent = BridgeEventOf<"thread.tokenUsage.updated">;
export type TurnStartedEvent = BridgeEventOf<"turn.started">;
export type TurnCompletedEvent = BridgeEventOf<"turn.completed">;
export type TurnFailedEvent = BridgeEventOf<"turn.failed">;
export type TurnStreamDeltaEvent = BridgeEventOf<"turn.stream.delta">;
export type TurnMessageCompletedEvent = BridgeEventOf<"turn.message.completed">;
export type TurnImageGeneratedEvent = BridgeEventOf<"turn.image.generated">;
export type TurnImageViewedEvent = BridgeEventOf<"turn.image.viewed">;
export type TurnActivityEvent = BridgeEventOf<"turn.activity">;
export type ApprovalRequestedEvent = BridgeEventOf<"approval.requested">;
export type ApprovalDecidedEvent = BridgeEventOf<"approval.decided">;
export type ApprovalAppliedEvent = BridgeEventOf<"approval.applied">;
export type ApprovalFailedEvent = BridgeEventOf<"approval.failed">;
