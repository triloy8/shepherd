import type { ConversationItem, VersionedItem, BoundedText } from "../../shared/protocol/v2/conversation_items.js";
import type { HistoryPage } from "../../shared/protocol/v2/conversations.js";
import type { BridgeEvent, ConversationSnapshot, ProjectionItemPage } from "../../shared/protocol/v2/events.js";

export interface NeutralChatState {
  epoch: string;
  sequence: number;
  historyRevision: string;
  overlays: Map<string, VersionedItem>;
  history: Map<string, ConversationItem>;
  needsResync: boolean;
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
    overlays: new Map(items.map(item => [item.item.id, structuredClone(item)])), history: new Map(), needsResync: false };
}
export function mergeNeutralHistory(state: NeutralChatState, page: HistoryPage): NeutralChatState {
  if (page.historyRevision !== state.historyRevision) return { ...state, needsResync: true };
  const history = new Map(state.history);
  for (const { item } of page.data) history.set(item.id, structuredClone(item));
  return { ...state, history };
}
export function neutralTimeline(state: NeutralChatState): ConversationItem[] {
  const items = new Map(state.history);
  for (const [id, { item }] of state.overlays) items.set(id, item);
  return [...items.values()];
}
export function reduceNeutralEvent(state: NeutralChatState, event: BridgeEvent): NeutralChatState {
  if (event.epoch !== state.epoch) return { ...state, overlays: new Map(), needsResync: true };
  if (event.sequence <= state.sequence) return state;
  if (state.needsResync || event.sequence !== state.sequence + 1) return { ...state, needsResync: true };
  const next = { ...state, sequence: event.sequence };
  if (event.type === "session.warning" && event.payload.code === "projection_incomplete") return { ...next, needsResync: true };
  if (event.type === "thread.reverted") return { ...next, historyRevision: event.payload.historyRevision,
    overlays: new Map(), history: new Map(), needsResync: true };
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
