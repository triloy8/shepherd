import { expect, test } from "bun:test";
import { assertItemBudget, boundText, encodeEventFrame, jsonBytes, OutputAccumulator, splitTextDeltas, V2_BUDGETS } from "../shared/protocol/v2/budgets.js";
import type { ConversationItem } from "../shared/protocol/v2/conversation_items.js";
import { ProjectionEventLog } from "../server/core/projection_event_log.js";
import { assistantItem } from "./helpers/provider_v2.js";

test("escaped text and Unicode are bounded by serialized bytes with intact code points and retained tail", () => {
  for (const text of ['"\\\n'.repeat(9000), "🦊漢字".repeat(9000), "x".repeat(9000)]) {
    const bounded = boundText(text, 1024, 256);
    expect(jsonBytes(bounded.text)).toBeLessThanOrEqual(1024);
    expect(bounded.truncated).toBe(true);
    expect(bounded.totalBytes).toBe(new TextEncoder().encode(text).byteLength);
    expect(bounded.text.isWellFormed()).toBe(true);
    expect(bounded.text.endsWith(text.slice(-6))).toBe(true);
  }
});

test("a 60 KiB answer remains complete and message metadata plus text fits the event frame", () => {
  const item = assistantItem("a".repeat(60 * 1024));
  expect(item.text.truncated).toBe(false);
  expect(item.text.text.length).toBe(60 * 1024);
  const event = new ProjectionEventLog("thread", "session").publish("item.completed", { item, revision: 1 });
  expect(encodeEventFrame(event).byteLength).toBeLessThan(V2_BUDGETS.messageFrameBytes);
  const nearMaximum = assistantItem("x".repeat(V2_BUDGETS.messageTextBytes - 2));
  nearMaximum.relatedItemIds = Array.from({ length: 10 }, () => "r".repeat(4090));
  expect(jsonBytes(nearMaximum)).toBeGreaterThan(288 * 1024);
  expect(() => assertItemBudget(nearMaximum)).not.toThrow();
  const frame = new ProjectionEventLog("thread", "session").publish("item.updated", { item: nearMaximum, revision: 1 });
  expect(encodeEventFrame(frame).byteLength).toBeLessThan(V2_BUDGETS.messageFrameBytes);
  expect(V2_BUDGETS.clientBytes).toBeGreaterThanOrEqual(4 * V2_BUDGETS.messageFrameBytes);
});

test("message text has an aggregate budget across all user parts", () => {
  const base = assistantItem();
  const item: ConversationItem = { ...base, type: "user_message", content: Array.from({ length: 2 }, () => ({
    type: "text" as const, text: boundText("x".repeat(140 * 1024), V2_BUDGETS.messageTextBytes),
  })), unavailableFields: [], omitted: {} };
  expect(() => assertItemBudget(item)).toThrow("message text");
  if (item.type === "user_message") item.content[1] = item.content[0];
  expect(() => assertItemBudget(item)).toThrow("message text");
});

test("small message text cannot borrow its larger budget for oversized metadata", () => {
  const item = assistantItem("hello");
  item.relatedItemIds = Array.from({ length: 20 }, () => "r".repeat(4000));
  expect(() => assertItemBudget(item)).toThrow("item metadata");
});

test("oversized tool fields and combined diffs are rejected even when the item fits", () => {
  const item: ConversationItem = { ...assistantItem(), type: "tool", source: "provider", server: null, name: "fixture",
    input: null, output: boundText("x".repeat(20 * 1024), 30 * 1024), assets: [], unavailableFields: [], omitted: {} };
  expect(jsonBytes(item)).toBeLessThan(V2_BUDGETS.itemBytes);
  expect(() => assertItemBudget(item)).toThrow("output");
  const changes: ConversationItem = { ...assistantItem(), type: "file_change", changes: Array.from({ length: 2 }, (_, i) => ({
    path: `file-${i}`, kind: "update" as const, movePath: null, diff: boundText("x".repeat(13 * 1024)), additions: null, deletions: null, applied: null,
  })), unavailableFields: [], omitted: {} };
  expect(() => assertItemBudget(changes)).toThrow("combined diffs");
});

test("delta splitting preserves escaped Unicode and the complete answer", () => {
  const text = '🦊"\\\n'.repeat(12000);
  const deltas = [...splitTextDeltas(text)];
  expect(deltas.join("")).toBe(text);
  for (const delta of deltas) {
    expect(jsonBytes(delta)).toBeLessThanOrEqual(V2_BUDGETS.deltaBytes);
    expect(delta.isWellFormed()).toBe(true);
  }
});

test("rolling output retains bounded head/tail after megabytes of output and counts split Unicode correctly", () => {
  const output = new OutputAccumulator();
  output.append("START\n");
  for (let i = 0; i < 100; i++) output.append("x".repeat(64 * 1024));
  output.append("\nEND");
  const result = output.read();
  expect(result.truncated).toBe(true);
  expect(result.text.startsWith("START")).toBe(true);
  expect(result.text.endsWith("END")).toBe(true);
  expect(jsonBytes(result.text)).toBeLessThanOrEqual(V2_BUDGETS.textBytes);
  expect(result.totalBytes).toBe(100 * 64 * 1024 + 10);
  const unicode = new OutputAccumulator();
  unicode.append("\ud83e"); unicode.append("\udd8a");
  expect(unicode.read()).toEqual({ text: "🦊", truncated: false, totalBytes: 4 });
});
