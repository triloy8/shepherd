import { expect, test } from "bun:test";
import { turnPage } from "../server/providers/claude/history.js";
import type { HistoryItem, HistoryTurn } from "../shared/protocol/requests.js";

function turn(items: HistoryItem[]): HistoryTurn {
  return { id: "t1", items, itemsView: "full", status: "completed", error: null, startedAt: null, completedAt: null, durationMs: null };
}
const user: HistoryItem = { id: "u", type: "user_message", content: [{ type: "text", text: "hi" }] };
const summary = (items: HistoryItem[]) => turnPage([turn(items)], { itemsView: "summary" }).data[0]!.items.map((item) => item.id);

test("a summary answers with the conversation's final message", () => {
  expect(summary([user, { id: "a", type: "assistant_message", text: "working", phase: "interim" }, { id: "b", type: "assistant_message", text: "done", phase: "final" }])).toEqual(["u", "b"]);
});

test("a summary falls back to the last unphased message of the conversation itself", () => {
  expect(summary([user, { id: "a", type: "assistant_message", text: "one" }, { id: "b", type: "assistant_message", text: "two" }])).toEqual(["u", "b"]);
});

test("a subagent's message and interim progress never answer a summary", () => {
  expect(summary([
    user,
    { id: "root", type: "assistant_message", text: "delegating", phase: "interim" },
    { id: "child", type: "assistant_message", text: "subagent progress", parentItemId: "task-1" },
  ])).toEqual(["u"]);
  expect(summary([
    user,
    { id: "root", type: "assistant_message", text: "answer" },
    { id: "child", type: "assistant_message", text: "subagent report", phase: "final", parentItemId: "task-1" },
  ])).toEqual(["u", "root"]);
});
