import { randomUUID } from "node:crypto";
import type { NeutralConversationSource } from "../ports/neutral_conversation.js";
import type { ConversationItem, VersionedItem, BoundedText } from "../../shared/protocol/v2/conversation_items.js";
import type { BridgeEvent, ConversationSnapshot, ConversationState, ProjectionItemPage, ProviderMutation } from "../../shared/protocol/v2/events.js";
import { assertItemBudget, assertJsonBudget, boundText, jsonBytes, V2_BUDGETS } from "../../shared/protocol/v2/budgets.js";
import { ProjectionEventLog, ProjectionRecoveryError, type ProjectionCursor } from "./projection_event_log.js";

const MAX_OVERLAY_BYTES = 8 * 1024 * 1024;
const CAPTURE_TTL_MS = 60_000;

/** One synchronous owner orders mutations and captures. SDK history stays outside it. */
export class ConversationProjection {
  private readonly log: ProjectionEventLog;
  private readonly overlays = new Map<string, VersionedItem>();
  private postRevertTurns: Set<string> | null = null;
  private readonly listeners = new Set<{ listener: (event: BridgeEvent) => void; onClose?: () => void }>();
  private readonly captures = new Map<string, { at: number; epoch: string; sequence: number; revision: string; items: VersionedItem[] }>();
  private state: ConversationState = { activeTurnId: null, backgroundTaskCount: 0, state: "idle", waitingFor: null };
  private capabilities: NeutralConversationSource["capabilities"];
  private historyRevision: string;
  private overlayBytes = 0;
  private closed = false;
  private readonly unsubscribe: () => void;

  constructor(threadId: string, sessionId: string, private readonly source: NeutralConversationSource) {
    this.log = new ProjectionEventLog(threadId, sessionId);
    this.capabilities = structuredClone(source.capabilities);
    this.historyRevision = source.historyRevision;
    this.unsubscribe = source.subscribe(mutation => {
      try { this.accept(mutation); }
      catch {
        this.deliver(this.log.publish("session.warning", { code: "projection_incomplete", message: boundText("Neutral state needs a refresh."), retryable: true }));
      }
    });
  }
  cursor(): ProjectionCursor { return this.log.cursor(); }
  eventsAfter(cursor: ProjectionCursor): BridgeEvent[] { return this.log.eventsAfter(cursor); }
  subscribe(listener: (event: BridgeEvent) => void, cursor?: ProjectionCursor, onClose?: () => void): () => void {
    if (this.closed) throw new ProjectionRecoveryError("Projection is closed.");
    // No awaits or native IO: replay and subscription are one ordered operation.
    const replay = cursor ? this.log.eventsAfter(cursor) : [];
    const subscription = { listener, onClose };
    this.listeners.add(subscription);
    try { for (const event of replay) listener(event); }
    catch (error) { this.listeners.delete(subscription); throw error; }
    return () => this.listeners.delete(subscription);
  }
  snapshot(): ConversationSnapshot {
    if (this.closed) throw new ProjectionRecoveryError("Projection is closed.");
    this.pruneCaptures();
    const cursor = this.log.cursor(), id = randomUUID();
    const items = structuredClone([...this.overlays.values()]);
    // At most two immutable captures retain no more than twice the bounded overlay.
    if (this.captures.size >= 2) this.captures.delete(this.captures.keys().next().value!);
    this.captures.set(id, { at: Date.now(), epoch: cursor.epoch, sequence: cursor.sequence, revision: this.historyRevision, items });
    const base = { epoch: cursor.epoch, throughSequence: cursor.sequence, historyRevision: this.historyRevision,
      state: structuredClone(this.state), capabilities: structuredClone(this.capabilities), interactions: [], itemsNextCursor: null };
    const page = this.page(id, 0, jsonBytes(base) + 128);
    const snapshot = { ...base, items: page.items, itemsNextCursor: page.nextCursor };
    assertJsonBudget(snapshot, V2_BUDGETS.pageBytes, "snapshot");
    return snapshot;
  }
  snapshotItems(cursor: string): ProjectionItemPage {
    this.pruneCaptures();
    const match = /^([a-f0-9-]{36}):(\d{1,8})$/.exec(cursor);
    if (!match) throw new ProjectionRecoveryError("Invalid snapshot cursor.");
    return this.page(match[1]!, Number(match[2]!), 256);
  }
  async readItems(cursor?: string) {
    const revision = this.historyRevision;
    const page = await this.source.readItems(cursor);
    if (this.closed || revision !== this.historyRevision || page.historyRevision !== revision) throw new ProjectionRecoveryError("History changed during its read.");
    // This page is unversioned native history. Never seed the delta base from it.
    return page;
  }
  readAsset(id: string) { return this.source.readAsset(id); }
  close(): void {
    if (this.closed) return;
    this.closed = true; this.unsubscribe();
    for (const { onClose } of [...this.listeners]) { try { onClose?.(); } catch { /* Teardown continues for other transports. */ } }
    this.listeners.clear(); this.captures.clear(); this.overlays.clear(); this.overlayBytes = 0;
  }
  private accept(mutation: ProviderMutation): void {
    if (this.closed) return;
    if (mutation.type === "item.started" || mutation.type === "item.updated" || mutation.type === "item.completed") {
      const item = mutation.payload, previous = this.overlays.get(item.id);
      if (this.postRevertTurns && !this.postRevertTurns.has(item.turnId)) return;
      assertItemBudget(item);
      if (previous && (item.turnId !== previous.item.turnId || item.type !== previous.item.type)) throw new ProjectionRecoveryError("Item identity changed.");
      if (previous && JSON.stringify(previous.item) === JSON.stringify(item)) return;
      // Sequence also provides a monotonic item version without an unbounded ID counter map.
      const revision = this.log.cursor().sequence + 1;
      const evictions = this.reserve(item);
      const event = this.log.publish(mutation.type, { item, revision });
      this.retain({ item: structuredClone(item), revision }, evictions);
      this.deliver(event);
    } else if (mutation.type === "item.delta") {
      const delta = mutation.payload, previous = this.overlays.get(delta.itemId);
      if (this.postRevertTurns && !this.postRevertTurns.has(delta.turnId)) return;
      if (!previous || previous.item.turnId !== delta.turnId) throw new ProjectionRecoveryError("Delta requires its item base.");
      assertJsonBudget(delta.delta, V2_BUDGETS.deltaBytes, "delta");
      const item = structuredClone(previous.item);
      let text: BoundedText | null | undefined;
      if (delta.field === "summary" && item.type === "reasoning") text = item.summary[delta.index];
      if (delta.field === "text" && "text" in item) text = item.text;
      if (delta.field === "output" && "output" in item) text = item.output;
      if (!text || text.truncated || delta.offset !== text.text.length) throw new ProjectionRecoveryError("Delta offset requires a full replacement.");
      text.text += delta.delta; text.totalBytes = new TextEncoder().encode(text.text).byteLength;
      assertItemBudget(item); const evictions = this.reserve(item);
      const revision = this.log.cursor().sequence + 1;
      const event = this.log.publish("item.delta", { ...delta, baseRevision: previous.revision, revision });
      this.retain({ item, revision }, evictions); this.deliver(event);
    } else if (mutation.type === "thread.reverted") {
      this.historyRevision = mutation.payload.historyRevision;
      this.overlays.clear(); this.overlayBytes = 0; this.captures.clear();
      this.postRevertTurns = new Set();
      this.deliver(this.log.invalidateHistory(this.historyRevision));
    } else {
      if (mutation.type === "turn.started") {
        if (this.state.activeTurnId === mutation.payload.turnId) return;
        this.state = { ...this.state, activeTurnId: mutation.payload.turnId, state: "active", waitingFor: null };
        if (this.postRevertTurns) {
          if (this.postRevertTurns.size >= 2000) this.postRevertTurns.delete(this.postRevertTurns.values().next().value!);
          this.postRevertTurns.add(mutation.payload.turnId);
        }
      }
      if (mutation.type === "turn.completed" || mutation.type === "turn.failed") {
        if (this.state.activeTurnId === mutation.payload.turnId) this.state = { ...this.state, activeTurnId: null, state: mutation.type === "turn.failed" ? "error" : "idle", waitingFor: null };
      }
      if (mutation.type === "thread.status.changed") this.state = structuredClone(mutation.payload);
      if (mutation.type === "thread.capabilities.changed") this.capabilities = structuredClone(mutation.payload.capabilities);
      // These discriminated payloads have already crossed the typed adapter boundary.
      this.deliver(this.log.publish(mutation.type, mutation.payload));
    }
  }
  private reserve(item: ConversationItem): string[] {
    const previous = this.overlays.get(item.id);
    const needed = jsonBytes(item) - (previous ? jsonBytes(previous.item) : 0);
    let bytes = this.overlayBytes, count = this.overlays.size;
    const evictions: string[] = [];
    for (const [id, entry] of this.overlays) {
      if (bytes + needed <= MAX_OVERLAY_BYTES && (this.overlays.has(item.id) || count < 2000)) break;
      if (id !== item.id && entry.item.status !== "in_progress" && entry.item.status !== "unknown") {
        bytes -= jsonBytes(entry.item); count--; evictions.push(id);
      }
    }
    if (bytes + needed > MAX_OVERLAY_BYTES || (!this.overlays.has(item.id) && count >= 2000)) throw new ProjectionRecoveryError("Too much active projection state.");
    return evictions;
  }
  private retain(entry: VersionedItem, evictions: string[]): void {
    for (const id of evictions) { this.overlayBytes -= jsonBytes(this.overlays.get(id)!.item); this.overlays.delete(id); }
    this.overlayBytes -= this.overlays.has(entry.item.id) ? jsonBytes(this.overlays.get(entry.item.id)!.item) : 0;
    this.overlays.set(entry.item.id, entry); this.overlayBytes += jsonBytes(entry.item);
  }
  private deliver(event: BridgeEvent): void {
    for (const { listener } of this.listeners) { try { listener(structuredClone(event)); } catch { /* One transport cannot fail provider work or another subscriber. */ } }
  }
  private pruneCaptures(): void {
    for (const [id, capture] of this.captures) if (capture.at + CAPTURE_TTL_MS < Date.now()) this.captures.delete(id);
  }
  private page(id: string, offset: number, overhead: number): ProjectionItemPage {
    const capture = this.captures.get(id);
    if (this.closed || !capture || capture.revision !== this.historyRevision || offset > capture.items.length) throw new ProjectionRecoveryError("Snapshot cursor expired.");
    const items: VersionedItem[] = [];
    let bytes = overhead;
    for (const item of capture.items.slice(offset, offset + 100)) {
      const cost = jsonBytes(item) + 1;
      if (bytes + cost > V2_BUDGETS.pageBytes) break;
      items.push(item); bytes += cost;
    }
    const nextOffset = offset + items.length;
    return structuredClone({ epoch: capture.epoch, throughSequence: capture.sequence, items,
      nextCursor: nextOffset < capture.items.length ? `${id}:${nextOffset}` : null });
  }
}
