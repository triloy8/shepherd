import { jsonBytes } from "../../shared/protocol/v2/budgets.js";
import type { ConversationItem, VersionedItem, BoundedText } from "../../shared/protocol/v2/conversation_items.js";
import type { HistoryPage } from "../../shared/protocol/v2/conversations.js";
import type { BridgeEvent, ConversationSnapshot, ProjectionItemPage } from "../../shared/protocol/v2/events.js";

export interface NeutralChatState {
  epoch: string;
  sequence: number;
  historyRevision: string;
  overlays: Map<string, VersionedItem>;
  history: Map<string, ConversationItem>;
  retained: Map<string, ConversationItem>;
  needsResync: boolean;
  conversation: ConversationSnapshot["state"];
  capabilities: ConversationSnapshot["capabilities"];
  interactions: Map<string, ConversationSnapshot["interactions"][number]>;
  endedTurns: string[];
  error: string | null;
}
/** The caller buffers events while fetching the immutable overlay continuation pages. */
export function hydrateNeutral(snapshot: ConversationSnapshot, pages: ProjectionItemPage[] = []): NeutralChatState {
  const items = [...snapshot.items];
  for (const page of pages) {
    if (page.epoch !== snapshot.epoch || page.throughSequence !== snapshot.throughSequence) throw new Error("Snapshot pages belong to different captures.");
    items.push(...page.items);
  }
  if ((snapshot.itemsNextCursor && !pages.length) || pages.at(-1)?.nextCursor) throw new Error("Snapshot capture is incomplete.");
  return { epoch: snapshot.epoch, sequence: snapshot.throughSequence, historyRevision: snapshot.historyRevision,
    overlays: new Map(items.map(item => [item.item.id, structuredClone(item)])), history: new Map(), retained: new Map(), needsResync: false, conversation: structuredClone(snapshot.state), capabilities: structuredClone(snapshot.capabilities), interactions: new Map(snapshot.interactions.map(record => [record.id, structuredClone(record)])), endedTurns: [], error: null };
}
/** Preserve session-only terminal items separately from forward-paged native history. */
export function recaptureNeutral(previous: NeutralChatState | null, snapshot: ConversationSnapshot, pages: ProjectionItemPage[] = []): NeutralChatState {
  const next = hydrateNeutral(snapshot, pages);
  if (!previous || previous.epoch !== next.epoch || previous.historyRevision !== next.historyRevision) return next;
  next.history = new Map(previous.history); next.retained = new Map(previous.retained); next.endedTurns = previous.endedTurns;
  for (const [id, entry] of previous.overlays) if (entry.item.status !== "in_progress" && !next.overlays.has(id)) next.retained.set(id, structuredClone(entry.item));
  let bytes = [...next.retained.values()].reduce((total, item) => total + jsonBytes(item), 0);
  for (const [id, item] of next.retained) {
    if (bytes <= 8 * 1024 * 1024) break;
    bytes -= jsonBytes(item); next.retained.delete(id);
  }
  return next;
}
export function mergeNeutralHistory(state: NeutralChatState, page: HistoryPage): NeutralChatState {
  if (page.historyRevision !== state.historyRevision) return { ...state, needsResync: true };
  const history = new Map(state.history);
  for (const { item } of page.data) history.set(item.id, structuredClone(item));
  return { ...state, history };
}
export function neutralTimeline(state: NeutralChatState): ConversationItem[] {
  const items = new Map(state.history);
  for (const [id, item] of state.retained) items.set(id, item);
  for (const [id, { item }] of state.overlays) items.set(id, item);
  return [...items.values()];
}
export function reduceNeutralEvent(state: NeutralChatState, event: BridgeEvent): NeutralChatState {
  if (event.epoch !== state.epoch) return { ...state, overlays: new Map(), needsResync: true };
  if (event.sequence <= state.sequence) return state;
  if (state.needsResync || event.sequence !== state.sequence + 1) return { ...state, needsResync: true };
  const next = { ...state, sequence: event.sequence };
  if (event.type === "thread.status.changed") return { ...next, conversation: structuredClone(event.payload) };
  if (event.type === "thread.capabilities.changed") return { ...next, capabilities: structuredClone(event.payload.capabilities) };
  if (event.type === "turn.started") return { ...next, conversation: { ...state.conversation, activeTurnId: event.payload.turnId, state: "active", waitingFor: null }, error: null };
  if (event.type === "turn.completed" || event.type === "turn.failed") return { ...next,
    endedTurns: [...state.endedTurns.filter(id => id !== event.payload.turnId), event.payload.turnId].slice(-512),
    error: event.type === "turn.failed" ? event.payload.error.message.text : state.error,
    conversation: state.conversation.activeTurnId === event.payload.turnId ? { ...state.conversation, activeTurnId: null, state: event.type === "turn.failed" ? "error" : "idle", waitingFor: null } : state.conversation };
  if (event.type.startsWith("interaction.")) {
    const record = event.payload as ConversationSnapshot["interactions"][number];
    const interactions = new Map(state.interactions);
    if (record.status === "pending") interactions.set(record.id, structuredClone(record)); else interactions.delete(record.id);
    return { ...next, interactions };
  }
  if (event.type === "session.error") return { ...next, error: event.payload.message.text };
  if (event.type === "session.warning" && event.payload.code === "projection_incomplete") return { ...next, needsResync: true };
  if (event.type === "thread.reverted") return { ...next, historyRevision: event.payload.historyRevision,
    overlays: new Map(), history: new Map(), retained: new Map(), needsResync: true };
  if (event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") {
    const previous = state.overlays.get(event.payload.item.id);
    if (previous && previous.revision >= event.payload.revision) return next;
    const overlays = new Map(state.overlays); overlays.set(event.payload.item.id, structuredClone(event.payload));
    return { ...next, overlays };
  }
  if (event.type === "item.delta") {
    const delta = event.payload, previous = state.overlays.get(delta.itemId);
    if (previous && delta.revision <= previous.revision) return next;
    if (!previous || previous.revision !== delta.baseRevision || previous.item.turnId !== delta.turnId) return { ...state, needsResync: true };
    const item = structuredClone(previous.item);
    let text: BoundedText | null | undefined;
    if (delta.field === "summary" && item.type === "reasoning") text = item.summary[delta.index];
    if (delta.field === "text" && "text" in item) text = item.text;
    if (delta.field === "output" && "output" in item) text = item.output;
    if (!text || text.truncated || delta.offset !== text.text.length) return { ...state, needsResync: true };
    text.text += delta.delta; text.totalBytes = new TextEncoder().encode(text.text).byteLength;
    const overlays = new Map(state.overlays); overlays.set(item.id, { item, revision: delta.revision });
    return { ...next, overlays };
  }
  return next;
}
