import type { BoundedText, VersionedItem } from "./conversation_items.js";
import type { ProviderCapabilities, TokenUsage } from "./conversations.js";
import type { InteractionRecord } from "./interactions.js";

export interface ConversationState {
  activeTurnId: string | null;
  backgroundTaskCount: number;
  state: "idle" | "active" | "waiting" | "error";
  waitingFor: "approval" | "user_input" | null;
}
export type ItemDeltaContent = {
  itemId: string; turnId: string; offset: number; delta: string;
} & (
  | { field: "text" | "output"; index: null }
  | { field: "summary"; index: number }
);
export type ItemDelta = ItemDeltaContent & { baseRevision: number; revision: number };
export interface EventPayloads {
  "item.started": VersionedItem;
  "item.updated": VersionedItem;
  "item.completed": VersionedItem;
  "item.delta": ItemDelta;
  "interaction.requested": InteractionRecord;
  "interaction.decided": InteractionRecord;
  "interaction.applied": InteractionRecord;
  "interaction.failed": InteractionRecord;
  "interaction.expired": InteractionRecord;
  "turn.started": { turnId: string };
  "turn.completed": { turnId: string; status: "completed" | "interrupted" };
  "turn.failed": { turnId: string; error: NeutralError };
  "thread.status.changed": ConversationState;
  "thread.capabilities.changed": { capabilities: ProviderCapabilities };
  "thread.name.updated": { name: string | null };
  "thread.archived": Record<string, never>;
  "thread.unarchived": Record<string, never>;
  "thread.reverted": { historyRevision: string };
  "thread.tokenUsage.updated": { turnId: string | null; usage: TokenUsage | null };
  "session.started": { model: string | null };
  "session.warning": NeutralError;
  "session.error": NeutralError;
  "session.limit.context": NeutralError;
}
export interface NeutralError { code: string; message: BoundedText; retryable: boolean }
export interface EventEnvelope {
  id: string;
  threadId: string;
  sessionId: string;
  ts: number;
  epoch: string;
  sequence: number;
}
export type BridgeEvent = {
  [K in keyof EventPayloads]: EventEnvelope & { type: K; payload: EventPayloads[K] }
}[keyof EventPayloads];

/** Adapter mutations have no projection epoch, sequence, or item revision. */
export type ProviderMutation = {
  [K in keyof EventPayloads]: { type: K; payload:
    K extends "item.started" | "item.updated" | "item.completed" ? VersionedItem["item"]
    : K extends "item.delta" ? ItemDeltaContent
    : EventPayloads[K]
  }
}[keyof EventPayloads];

/** These overlays and their revisions are captured together at throughSequence.
 * Native history pages are separate and must not overwrite versioned overlays.
 */
export interface ConversationSnapshot {
  epoch: string;
  throughSequence: number;
  historyRevision: string;
  state: ConversationState;
  capabilities: ProviderCapabilities;
  items: VersionedItem[];
  itemsNextCursor: string | null;
  interactions: InteractionRecord[];
}
export interface ProjectionItemPage {
  epoch: string;
  throughSequence: number;
  items: VersionedItem[];
  nextCursor: string | null;
}
