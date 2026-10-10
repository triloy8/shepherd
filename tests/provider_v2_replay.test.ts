import { expect, test } from "bun:test";
import { ProjectionEventLog } from "../server/core/projection_event_log.js";
import { V2_BUDGETS } from "../shared/protocol/v2/budgets.js";
import { assistantItem } from "./helpers/provider_v2.js";

test("a snapshot watermark replays only subsequent events and returned objects cannot corrupt replay", () => {
  const log = new ProjectionEventLog("thread", "session");
  const before = log.cursor();
  const item = assistantItem("hello");
  log.publish("item.started", { item, revision: 1 });
  const snapshotWatermark = log.cursor();
  const delta = { itemId: item.id, turnId: item.turnId, baseRevision: 1, revision: 2, field: "text" as const, index: null, offset: 5, delta: " world" };
  const returned = log.publish("item.delta", delta);
  returned.sequence = -1;
  delta.delta = "corrupted";
  item.text.text = "corrupted";
  expect(log.eventsAfter(snapshotWatermark).map(({ type }) => type)).toEqual(["item.delta"]);
  const events = log.eventsAfter(before);
  expect(events[0].type === "item.started" && events[0].payload.item.type === "assistant_message" && events[0].payload.item.text.text).toBe("hello");
  expect(events[1].type === "item.delta" && events[1].payload.delta).toBe(" world");
  events[1].sequence = -10;
  expect(log.eventsAfter(before)[1].sequence).toBe(2);
});

test("count eviction, unknown epochs, future cursors, and reverted history explicitly require recovery", () => {
  const log = new ProjectionEventLog("thread", "session");
  const beginning = log.cursor();
  for (let i = 0; i <= V2_BUDGETS.replayEvents; i++) log.publish("turn.started", { turnId: `turn-${i}` });
  expect(() => log.eventsAfter(beginning)).toThrow("new snapshot");
  expect(log.eventsAfter({ epoch: log.epoch, sequence: 1 })).toHaveLength(V2_BUDGETS.replayEvents);
  expect(() => log.eventsAfter({ epoch: "previous-process", sequence: 1 })).toThrow("new snapshot");
  expect(() => log.eventsAfter({ epoch: log.epoch, sequence: 10000 })).toThrow("new snapshot");
  expect(() => log.eventsAfter({ epoch: log.epoch, sequence: -1 })).toThrow("new snapshot");
  const beforeRevert = log.cursor();
  log.invalidateHistory("history-2");
  expect(log.eventsAfter(beforeRevert).map(({ type }) => type)).toEqual(["thread.reverted"]);
  expect(() => log.eventsAfter({ epoch: log.epoch, sequence: beforeRevert.sequence - 1 })).toThrow("new snapshot");
});

test("byte eviction bounds replay independently of event count while several large messages remain replayable", () => {
  const log = new ProjectionEventLog("thread", "session");
  const beginning = log.cursor();
  const item = assistantItem("x".repeat(250 * 1024));
  for (let i = 1; i <= 4; i++) log.publish("item.updated", { item, revision: i });
  expect(log.eventsAfter(beginning)).toHaveLength(4);
  for (let i = 5; i <= 30; i++) log.publish("item.updated", { item, revision: i });
  expect(() => log.eventsAfter(beginning)).toThrow("new snapshot");
  expect(log.eventsAfter({ epoch: log.epoch, sequence: 29 })).toHaveLength(1);
});

test("a rejected oversized event does not consume a sequence or poison replay", () => {
  const log = new ProjectionEventLog("thread", "session");
  const beginning = log.cursor();
  expect(() => log.publish("item.delta", { itemId: "message", turnId: "turn", baseRevision: 1, revision: 2,
    field: "text", index: null, offset: 0, delta: "x".repeat(5000) })).toThrow("delta");
  expect(log.cursor()).toEqual(beginning);
  expect(log.publish("turn.started", { turnId: "turn" }).sequence).toBe(1);
});
