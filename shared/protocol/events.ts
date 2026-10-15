import type { ApprovalRecord, ApprovalRequestPayload } from "./approvals.js";
import type { ApprovalPolicy, HistoryItem, ThreadTokenUsage } from "./requests.js";

/** Interim text reports progress during a turn; final text answers it. */
export type MessagePhase = "interim" | "final";

/** Which part of an item a delta extends: assistant message text, plan text, a reasoning
 * summary, or an activity's output. */
export type ItemDeltaChannel = "message" | "plan" | "reasoning" | "output";

/** A turn's items stream live as the records history returns: `item.started` for items that
 * take time, `item.delta` for streamed text, and `item.completed` with the canonical item.
 * Null turn IDs refer to the current turn. Providers must supply IDs for delayed events
 * belonging to an earlier turn. Null delta item IDs refer to the pending message, which
 * is anonymous until an identified delta/completion supplies its canonical identity. */
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
  /** An item that takes time has begun; it is the same record history returns, in its current state. */
  "item.started": { turnId: string | null; item: HistoryItem };
  /** Streamed text for an item. Only `message` text is part of an assistant message. */
  "item.delta": { turnId: string | null; itemId: string | null; channel: ItemDeltaChannel; delta: string; phase: MessagePhase | null };
  /** The canonical item, equal to what history returns for it. */
  "item.completed": { turnId: string | null; item: HistoryItem };
  "approval.requested": ApprovalRequestPayload;
  /** Reused native IDs need requestEventId (the request event ID), or a uniquely identifying turnId. */
  "approval.decided": { approvalId: string; decision: string; state: ApprovalRecord["status"]; turnId?: string | null; requestEventId?: string };
  "approval.applied": { approvalId: string; turnId?: string | null; requestEventId?: string };
  "approval.failed": { approvalId: string; message: string; turnId?: string | null; requestEventId?: string };
  "approval.expired": { approvalId: string; turnId?: string | null; requestEventId?: string };
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
export type ItemStartedEvent = BridgeEventOf<"item.started">;
export type ItemDeltaEvent = BridgeEventOf<"item.delta">;
export type ItemCompletedEvent = BridgeEventOf<"item.completed">;
export type ApprovalRequestedEvent = BridgeEventOf<"approval.requested">;
export type ApprovalDecidedEvent = BridgeEventOf<"approval.decided">;
export type ApprovalAppliedEvent = BridgeEventOf<"approval.applied">;
export type ApprovalFailedEvent = BridgeEventOf<"approval.failed">;
