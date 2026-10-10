import { expect, test } from "bun:test";
import { NativeConversationSource } from "../server/providers/neutral_source.js";
import { ConversationProjection } from "../server/core/conversation_projection.js";
import { assistantItem, capabilities } from "./helpers/provider_v2.js";
import { jsonBytes, V2_BUDGETS } from "../shared/protocol/v2/budgets.js";
import { hydrateNeutral, recaptureNeutral, mergeNeutralHistory, neutralTimeline, reduceNeutralEvent } from "./helpers/neutral-chat-state.js";
import type { BridgeEvent, ProviderMutation } from "../shared/protocol/v2/events.js";

function harness() {
  const source = new NativeConversationSource(capabilities(), async () => ({ data: [], nextCursor: null }));
  source.bind("thread");
  const projection = new ConversationProjection("thread", "session", source);
  return { source, projection };
}

test("snapshot includes the exact revision needed for the next delta and replay duplicates do not append twice", () => {
  const { source, projection } = harness();
  source.emit({ type: "item.started", payload: assistantItem("hello") });
  const snapshot = projection.snapshot();
  expect(snapshot.items[0].revision).toBe(1);
  source.emit({ type: "item.delta", payload: { itemId: "message", turnId: "turn", field: "text", index: null, offset: 5, delta: " 🦊" } });
  const events = projection.eventsAfter({ epoch: snapshot.epoch, sequence: snapshot.throughSequence });
  let state = hydrateNeutral(snapshot);
  state = reduceNeutralEvent(state, events[0]); state = reduceNeutralEvent(state, events[0]);
  expect(neutralTimeline(state)).toMatchObject([{ type: "assistant_message", text: { text: "hello 🦊" } }]);
  expect(state.needsResync).toBe(false);
  expect(projection.snapshot().items[0].item).toEqual(neutralTimeline(state)[0]);
  projection.close();
});

test("history ahead of a snapshot never becomes the base of buffered deltas", () => {
  const { source, projection } = harness();
  source.emit({ type: "item.started", payload: assistantItem("hello") });
  const snapshot = projection.snapshot();
  source.emit({ type: "item.delta", payload: { itemId: "message", turnId: "turn", field: "text", index: null, offset: 5, delta: " world" } });
  let state = mergeNeutralHistory(hydrateNeutral(snapshot), { data: [{ turnId: "turn", item: assistantItem("hello world") }], nextCursor: null, backwardsCursor: null, historyRevision: snapshot.historyRevision });
  expect(neutralTimeline(state)).toMatchObject([{ text: { text: "hello" } }]);
  state = reduceNeutralEvent(state, projection.eventsAfter({ epoch: snapshot.epoch, sequence: snapshot.throughSequence })[0]);
  expect(neutralTimeline(state)).toMatchObject([{ text: { text: "hello world" } }]);
  expect(state.needsResync).toBe(false);
});

test("native history with no version cannot accept a delta and missing sequence or epoch requires resync", () => {
  const { source, projection } = harness();
  const snapshot = projection.snapshot();
  const history = { data: [{ turnId: "turn", item: assistantItem("prefix") }], nextCursor: null, backwardsCursor: null, historyRevision: snapshot.historyRevision };
  const state = mergeNeutralHistory(hydrateNeutral(snapshot), history);
  const event: BridgeEvent = { id: "event", threadId: "thread", sessionId: "session", ts: 0, epoch: snapshot.epoch, sequence: 1,
    type: "item.delta", payload: { itemId: "message", turnId: "turn", baseRevision: 1, revision: 2, field: "text", index: null, offset: 6, delta: "more" } };
  expect(reduceNeutralEvent(state, event).needsResync).toBe(true);
  expect(reduceNeutralEvent(state, { ...event, sequence: 4 }).needsResync).toBe(true);
  expect(reduceNeutralEvent(state, { ...event, epoch: "new-process" }).needsResync).toBe(true);
  source.emit({ type: "item.delta", payload: { itemId: "missing", turnId: "turn", field: "text", index: null, offset: 0, delta: "gap" } });
  expect(projection.eventsAfter(projection.cursor())).toEqual([]);
  expect(projection.snapshot().items).toEqual([]);
});

test("paged snapshots stay frozen while completion and deltas arrive, and revert invalidates their cursors", () => {
  const { source, projection } = harness();
  for (let i = 0; i < 8; i++) source.emit({ type: "item.started", payload: assistantItem("x".repeat(240 * 1024), `message-${i}`) });
  const snapshot = projection.snapshot();
  expect(jsonBytes(snapshot)).toBeLessThanOrEqual(V2_BUDGETS.pageBytes);
  expect(snapshot.itemsNextCursor).not.toBeNull();
  source.emit({ type: "item.completed", payload: { ...assistantItem("finished", "message-7"), status: "completed" } });
  const pages = [];
  let cursor = snapshot.itemsNextCursor;
  while (cursor) { const page = projection.snapshotItems(cursor); expect(jsonBytes(page)).toBeLessThanOrEqual(V2_BUDGETS.pageBytes); pages.push(page); cursor = page.nextCursor; }
  let state = hydrateNeutral(snapshot, pages);
  expect(neutralTimeline(state)[7]).toMatchObject({ status: "in_progress", text: { text: "x".repeat(240 * 1024) } });
  for (const event of projection.eventsAfter({ epoch: snapshot.epoch, sequence: snapshot.throughSequence })) state = reduceNeutralEvent(state, event);
  expect(neutralTimeline(state)[7]).toMatchObject({ status: "completed", text: { text: "finished" } });
  source.invalidateHistory();
  expect(() => projection.snapshotItems(snapshot.itemsNextCursor!)).toThrow("expired");
  source.emit({ type: "item.completed", payload: { ...assistantItem("stale", "message-7"), status: "completed" } });
  expect(projection.snapshot().items).toEqual([]);
  source.emit({ type: "turn.started", payload: { turnId: "new-turn" } });
  source.emit({ type: "item.started", payload: { ...assistantItem("new", "new-item"), turnId: "new-turn" } });
  expect(projection.snapshot().items).toHaveLength(1);
});

test("native read crossing revert is rejected and invalid deltas never replace valid projection state", async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const source = new NativeConversationSource(capabilities(), async () => { await pending; return { data: [], nextCursor: null }; });
  source.bind("thread");
  const projection = new ConversationProjection("thread", "session", source);
  const read = projection.readItems(); source.invalidateHistory(); release();
  await expect(read).rejects.toThrow("History changed");
  source.emit({ type: "turn.started", payload: { turnId: "turn" } });
  source.emit({ type: "item.started", payload: assistantItem("valid") });
  const mutation: ProviderMutation = { type: "item.delta", payload: { itemId: "message", turnId: "turn", field: "text", index: null, offset: 99, delta: "bad" } };
  source.emit(mutation);
  expect(projection.snapshot().items[0].item).toMatchObject({ text: { text: "valid" } });
});

test("an observer failure cannot stop delivery or mutate another subscriber's event", () => {
  const { source, projection } = harness();
  const received: BridgeEvent[] = [];
  projection.subscribe(() => { throw new Error("closed transport"); });
  projection.subscribe(event => { event.sequence = -1; });
  projection.subscribe(event => received.push(event));
  source.emit({ type: "turn.started", payload: { turnId: "turn" } });
  expect(received[0].sequence).toBe(1);
  expect(projection.snapshot().state.activeTurnId).toBe("turn");
});

test("history continuation hides native cursors, rejects loops, and expires across revert", async () => {
  let loop = false;
  const nativeCursors: Array<string | undefined> = [];
  const source = new NativeConversationSource(capabilities(), async (_thread, cursor) => {
    nativeCursors.push(cursor);
    return { data: [{ turnId: "turn", item: assistantItem("history") }], nextCursor: loop ? cursor! : "native-private-cursor" };
  });
  source.bind("thread");
  const first = await source.readItems();
  expect(first.nextCursor).not.toBe("native-private-cursor");
  loop = true;
  await expect(source.readItems(first.nextCursor!)).rejects.toThrow("did not progress");
  expect(nativeCursors).toEqual([undefined, "native-private-cursor"]);
  source.invalidateHistory();
  await expect(source.readItems(first.nextCursor!)).rejects.toThrow("new page");
  source.close();
});

test("lazy assets cannot finish after their authorization has been invalidated", async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const { source, projection } = harness();
  const asset = source.asset("image", "image", "image/png", "image.png", async () => {
    await pending; return { bytes: new Uint8Array([1, 2]), mimeType: "image/png", name: "image.png" };
  });
  const read = source.readAsset(asset.id);
  source.invalidateHistory(); release();
  await expect(read).rejects.toThrow("unavailable");
  projection.close(); source.close();
});

test("new captures expire old cursors while each retained capture stays immutable", () => {
  const { source, projection } = harness();
  for (let i = 0; i < 6; i++) source.emit({ type: "item.started", payload: assistantItem("x".repeat(240 * 1024), `message-${i}`) });
  const old = projection.snapshot();
  const retained = projection.snapshot();
  projection.snapshot();
  expect(() => projection.snapshotItems(old.itemsNextCursor!)).toThrow("expired");
  expect(projection.snapshotItems(retained.itemsNextCursor!).items.length).toBeGreaterThan(0);
  projection.close(); source.close();
});

test("recapture preserves terminal overlays without putting live items ahead of forward-paged history", () => {
  const source = new NativeConversationSource(capabilities(), async () => ({ data: [], nextCursor: null })); source.bind("thread");
  const projection = new ConversationProjection("thread", "session", source), snapshot = projection.snapshot();
  let state = hydrateNeutral(snapshot);
  state = mergeNeutralHistory(state, { data: [{ turnId: "old", item: { ...assistantItem("old", "old"), status: "completed" } }], nextCursor: "more", backwardsCursor: null, historyRevision: snapshot.historyRevision });
  state.overlays.set("recent", { item: { ...assistantItem("recent", "recent"), status: "completed" }, revision: 1 });
  let next = recaptureNeutral(state, snapshot);
  next = mergeNeutralHistory(next, { data: [{ turnId: "middle", item: { ...assistantItem("middle", "middle"), status: "completed" } }], nextCursor: null, backwardsCursor: null, historyRevision: snapshot.historyRevision });
  expect(neutralTimeline(next).map(item => item.id)).toEqual(["old", "middle", "recent"]);
  expect(next.history.has("recent")).toBe(false);
  expect(recaptureNeutral(next, { ...snapshot, historyRevision: "changed" }).retained.size).toBe(0);
  projection.close(); source.close();
});
