import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { emptyChat, mergeHistory, reduceBridge } from "../ui/src/chat-state";
import { timelineGroups } from "../ui/src/timeline";
import { Timeline } from "../ui/src/components/Timeline";
import type { HistoryTurn } from "../shared/protocol/requests";
import type { BridgeEvent } from "../shared/protocol/events";

const turn = (status: HistoryTurn["status"] = "completed"): HistoryTurn => ({
  id: "turn", status, itemsView: "full", error: null, startedAt: null, completedAt: null, durationMs: 3200,
  items: [{ id: "user", type: "userMessage", content: [{ type: "text", text: "Help" }] },
    { id: "progress", type: "agentMessage", phase: "commentary", text: "Checking the project" },
    { id: "answer", type: "agentMessage", phase: "final_answer", text: "The answer" }],
});
const event = (id: string, type: BridgeEvent["type"], payload: unknown): BridgeEvent => ({ id, type, payload, threadId: "thread", sessionId: "session", ts: "2026-01-01T00:00:00Z" });
const render = (state: ReturnType<typeof emptyChat>) => renderToStaticMarkup(createElement(Timeline, { chat: state }));

test("completed history folds commentary with only the final answer copyable", () => {
  const state = mergeHistory(emptyChat(), [turn()]);
  expect(timelineGroups(state)[1]).toMatchObject({ finalIds: ["answer"], settled: true, label: "Worked for 3s" });
  const html = render(state);
  expect(html).toContain("<details");
  expect(html).not.toContain(" open=");
  expect(html.match(/aria-label="Copy response"/g)).toHaveLength(1);
  expect(html.indexOf("Checking the project")).toBeLessThan(html.indexOf("</details>"));
  expect(html.indexOf("The answer")).toBeGreaterThan(html.indexOf("</details>"));
});

test("live message completion does not fold a running turn or add copy buttons", () => {
  let state = mergeHistory(emptyChat(), [turn("inProgress")]);
  state.activeTurnId = "turn";
  state = reduceBridge(state, event("done", "turn.message.completed", { turnId: "turn", itemId: "progress", phase: "commentary", text: "Checking the project" }));
  expect(state.messages.find((m) => m.id === "progress")?.phase).toBe("commentary");
  expect(render(state)).not.toContain("<details");
  expect(render(state)).not.toContain('aria-label="Copy response"');
  expect(render(state)).toContain("Working…");
  state = reduceBridge(state, event("end", "turn.completed", { turnId: "turn" }));
  expect(timelineGroups(state)[1]!.settled).toBe(false);
  state = mergeHistory(state, [turn()]);
  expect(timelineGroups(state)[1]!.settled).toBe(true);
});

test("failed and interrupted history stays visible after reload", () => {
  for (const status of ["failed", "interrupted"] as const) {
    const state = mergeHistory(emptyChat(), [turn(status)]);
    expect(render(state)).not.toContain("<details");
    expect(render(state)).toContain("Checking the project");
    expect(render(state)).toContain("The answer");
  }
});

test("unphased legacy history uses the last message; commentary-only turns have no final", () => {
  const legacy = turn();
  for (const item of legacy.items) delete item.phase;
  expect(timelineGroups(mergeHistory(emptyChat(), [legacy]))[1]!.finalIds).toEqual(["answer"]);
  const commentary = turn(); commentary.items.pop();
  const state = mergeHistory(emptyChat(), [commentary]);
  expect(timelineGroups(state)[1]!.finalIds).toEqual([]);
  expect(render(state)).not.toContain('aria-label="Copy response"');
});

test("user follow-ups stay outside progress and preserve timeline order", () => {
  const history = turn();
  history.items.splice(2, 0, { id: "followup", type: "userMessage", content: [{ type: "text", text: "Also this" }] });
  const groups = timelineGroups(mergeHistory(emptyChat(), [history]));
  expect(groups.map((g) => g.id)).toEqual(["user", "progress", "followup", "answer"]);
});

test("streamed phases survive completion without a repeated phase", () => {
  let state = reduceBridge(emptyChat(), event("delta", "turn.stream.delta", { method: "item/agentMessage/delta", itemId: "progress", turnId: "turn", phase: "commentary", textDelta: "Checking" }));
  state = reduceBridge(state, event("done", "turn.message.completed", { itemId: "progress", turnId: "turn", text: "Checking done" }));
  expect(state.messages[0]!.phase).toBe("commentary");
});

test("legacy follow-ups never promote an earlier update to another final answer", () => {
  const history = turn();
  for (const item of history.items) delete item.phase;
  history.items.splice(2, 0, { id: "followup", type: "userMessage", content: [{ type: "text", text: "Also this" }] });
  const groups = timelineGroups(mergeHistory(emptyChat(), [history]));
  expect(groups.flatMap((g) => g.finalIds)).toEqual(["answer"]);
});

test("activity after an explicit final answer retains its position", () => {
  const history = turn();
  history.items.push({ id: "trailing", type: "agentMessage", phase: "commentary", text: "Follow-up update" });
  const state = mergeHistory(emptyChat(), [history]);
  const html = render(state);
  expect(html.indexOf("The answer")).toBeLessThan(html.indexOf("Follow-up update"));
});

test("history without phase metadata preserves known streamed phase", () => {
  const state = reduceBridge(emptyChat(), event("delta", "turn.message.completed", { itemId: "progress", turnId: "turn", phase: "commentary", text: "Checking the project" }));
  const history = turn(); delete history.items[1]!.phase;
  expect(mergeHistory(state, [history]).messages.find((m) => m.id === "progress")?.phase).toBe("commentary");
});

test("all explicit final messages remain visible and copyable", () => {
  const history = turn(); history.items.push({ id: "answer2", type: "agentMessage", phase: "final_answer", text: "Second answer part" });
  const state = mergeHistory(emptyChat(), [history]);
  expect(timelineGroups(state).flatMap((g) => g.finalIds)).toEqual(["answer", "answer2"]);
  expect(render(state).match(/aria-label="Copy response"/g)).toHaveLength(2);
});

test("stale turn completion and activity cannot clear a newer active turn", () => {
  let state = reduceBridge(emptyChat(), event("start", "turn.started", { turnId: "new" }));
  for (const type of ["turn.completed", "turn.failed", "turn.activity", "turn.stream.delta"] as const) {
    state = reduceBridge(state, event(type, type, { turnId: "old", itemId: "late", method: "item/agentMessage/delta", textDelta: "Late", status: "started", label: "Old command" }));
    expect(state.activeTurnId).toBe("new"); expect(state.messages).toHaveLength(0); expect(state.error).toBeNull();
  }
});

test("tool lifecycle updates one entry and keeps failures outside collapsed work", () => {
  let state = reduceBridge(emptyChat(), event("start", "turn.started", { turnId: "turn" }));
  state = reduceBridge(state, event("tool1", "turn.activity", { itemId: "tool", turnId: "turn", label: "Running command", detail: "bun test", kind: "command", status: "started" }));
  state = reduceBridge(state, event("tool2", "turn.activity", { itemId: "tool", turnId: "turn", label: "Running command", detail: "bun test", kind: "command", status: "failed" }));
  expect(state.messages).toHaveLength(1);
  state.activeTurnId = null; state.turns.turn = { status: "completed", durationMs: 1 };
  expect(render(state)).toContain("Failed"); expect(render(state)).not.toContain("progress-disclosure");
});

test("tool history survives reload and is not mistaken for a final answer", () => {
  const history = turn(); history.items.splice(2, 0, { id: "tool", type: "commandExecution", webActivity: { itemId: "tool", turnId: "turn", label: "Running command", detail: "bun test", kind: "command", status: "completed" } });
  const state = mergeHistory(emptyChat(), [history]);
  expect(state.messages.find((m) => m.id === "tool")?.activity?.status).toBe("completed");
  expect(timelineGroups(state).flatMap((g) => g.finalIds)).toEqual(["answer"]);
});
