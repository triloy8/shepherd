import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { emptyChat, mergeHistory, reduceBridge } from "../ui/src/chat-state";
import { timelineGroups } from "../ui/src/timeline";
import { Timeline } from "../ui/src/components/Timeline";
import type { HistoryTurn } from "../shared/protocol/requests";
import type { BridgeEvent } from "../shared/protocol/events";
import { presentHistoryItem } from "../server/adapters/web/history";
import { WebImages } from "../server/adapters/web/images";

const turn = (status: HistoryTurn["status"] = "completed"): HistoryTurn => ({
  id: "turn", status, itemsView: "full", error: null, startedAt: null, completedAt: null, durationMs: 3200,
  items: [{ id: "user", type: "user_message", content: [{ type: "text", text: "Help" }] },
    { id: "progress", type: "assistant_message", phase: "interim", text: "Checking the project" },
    { id: "answer", type: "assistant_message", phase: "final", text: "The answer" }],
});
const event = (id: string, type: BridgeEvent["type"], payload: unknown): BridgeEvent => ({ id, type, payload, threadId: "thread", sessionId: "session", ts: "2026-01-01T00:00:00Z" });
const render = (state: ReturnType<typeof emptyChat>) => renderToStaticMarkup(createElement(Timeline, { chat: state }));

test("plans and reasoning survive web presentation and render as progress rather than final answers", () => {
  const source = turn("in_progress");
  source.items = [
    { id: "plan", type: "plan", text: "Check the fixtures, then update the decoder." },
    { id: "reasoning", type: "reasoning", form: "summary", parts: ["The fixture is incomplete.", "Preserve its missing fields."] },
    { id: "answer", type: "assistant_message", phase: "final", text: "Updated the decoder." },
  ];
  const images = new WebImages("conversation");
  const presented = { ...source, items: source.items.map(item => presentHistoryItem(item, source.id, images)) };
  expect(presented.items.slice(0, 2)).toEqual(source.items.slice(0, 2));
  const state = mergeHistory(emptyChat(), [presented]);
  expect(state.messages[0]?.activity?.activity).toEqual({ kind: "other", title: "Plan", detail: source.items[0].text });
  expect(state.messages[1]?.activity?.activity).toEqual({ kind: "other", title: "Reasoning summary", detail: "The fixture is incomplete.\n\nPreserve its missing fields." });
  const html = render(state);
  expect(html).toContain("Check the fixtures, then update the decoder.");
  expect(html).toContain("The fixture is incomplete.");
  expect(html).toContain("Preserve its missing fields.");
  const completed = mergeHistory(emptyChat(), [{ ...presented, status: "completed" }]);
  expect(timelineGroups(completed)[0]?.finalIds).toEqual(["answer"]);
  const progressOnly = mergeHistory(emptyChat(), [{ ...presented, status: "completed", items: presented.items.slice(0, 2) }]);
  expect(timelineGroups(progressOnly)[0]?.finalIds).toEqual([]);
});

test("empty reasoning summaries do not create activity rows in live or completed history", () => {
  for (const status of ["in_progress", "completed"] as const) {
    const source = turn(status);
    source.items.splice(1, 0,
      { id: "empty-reasoning", type: "reasoning", form: "summary", parts: [] },
      { id: "blank-reasoning", type: "reasoning", form: "summary", parts: ["", " \n\t"] },
    );
    const images = new WebImages("conversation");
    const presented = { ...source, items: source.items.map(item => presentHistoryItem(item, source.id, images)) };
    const state = mergeHistory(emptyChat(), [presented]);
    expect(state.messages.map(message => message.id)).toEqual(["user", "progress", "answer"]);
    expect(render(state)).not.toContain("Reasoning summary");
    // A later history refresh can supply a real summary for the same item.
    presented.items[1] = { id: "empty-reasoning", type: "reasoning", form: "summary", parts: ["A useful summary."] };
    const refreshed = mergeHistory(state, [presented]);
    expect(refreshed.messages.find(message => message.id === "empty-reasoning")?.activity?.activity).toEqual({ kind: "other", title: "Reasoning summary", detail: "A useful summary." });
  }
});

test("completed history folds commentary with only the final answer copyable", () => {
  const state = mergeHistory(emptyChat(), [turn()]);
  expect(timelineGroups(state)[1]).toMatchObject({ finalIds: ["answer"], settled: true, label: "Worked for 3s" });
  const html = render(state);
  expect(html).toContain("<details");
  expect(html).not.toContain(" open=");
  expect(html.match(/aria-label="Copy response"/g)).toHaveLength(1);
  expect(html).not.toContain("Checking the project");
  expect(html.indexOf("The answer")).toBeGreaterThan(html.indexOf("</details>"));
});

test("live message completion does not fold a running turn or add copy buttons", () => {
  let state = mergeHistory(emptyChat(), [turn("in_progress")]);
  state.activeTurnId = "turn";
  state = reduceBridge(state, event("done", "item.completed", { turnId: "turn", item: { id: "progress", type: "assistant_message", text: "Checking the project", phase: "interim" } }));
  expect(state.messages.find((m) => m.id === "progress")?.phase).toBe("interim");
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
  history.items.splice(2, 0, { id: "followup", type: "user_message", content: [{ type: "text", text: "Also this" }] });
  const groups = timelineGroups(mergeHistory(emptyChat(), [history]));
  expect(groups.map((g) => g.id)).toEqual(["user", "progress", "followup", "answer"]);
});

test("streamed phases survive completion without a repeated phase", () => {
  let state = reduceBridge(emptyChat(), event("delta", "item.delta", { turnId: "turn", itemId: "progress", channel: "message", delta: "Checking", phase: "interim" }));
  state = reduceBridge(state, event("done", "item.completed", { turnId: "turn", item: { id: "progress", type: "assistant_message", text: "Checking done" } }));
  expect(state.messages[0]!.phase).toBe("interim");
});

test("legacy follow-ups never promote an earlier update to another final answer", () => {
  const history = turn();
  for (const item of history.items) delete item.phase;
  history.items.splice(2, 0, { id: "followup", type: "user_message", content: [{ type: "text", text: "Also this" }] });
  const groups = timelineGroups(mergeHistory(emptyChat(), [history]));
  expect(groups.flatMap((g) => g.finalIds)).toEqual(["answer"]);
});

test("activity after an explicit final answer retains its position", () => {
  const history = turn();
  history.items.push({ id: "trailing", type: "assistant_message", phase: "interim", text: "Follow-up update" });
  const state = mergeHistory(emptyChat(), [history]);
  const html = render(state);
  expect(html).toContain("The answer");
  expect(html).not.toContain("Follow-up update");
});

test("history without phase metadata preserves known streamed phase", () => {
  const state = reduceBridge(emptyChat(), event("delta", "item.completed", { turnId: "turn", item: { id: "progress", type: "assistant_message", text: "Checking the project", phase: "interim" } }));
  const history = turn(); delete history.items[1]!.phase;
  expect(mergeHistory(state, [history]).messages.find((m) => m.id === "progress")?.phase).toBe("interim");
});

test("all explicit final messages remain visible and copyable", () => {
  const history = turn(); history.items.push({ id: "answer2", type: "assistant_message", phase: "final", text: "Second answer part" });
  const state = mergeHistory(emptyChat(), [history]);
  expect(timelineGroups(state).flatMap((g) => g.finalIds)).toEqual(["answer", "answer2"]);
  expect(render(state).match(/aria-label="Copy response"/g)).toHaveLength(2);
});

test("stale turn completion and activity cannot clear a newer active turn", () => {
  let state = reduceBridge(emptyChat(), event("start", "turn.started", { turnId: "new" }));
  for (const type of ["turn.completed", "turn.failed", "turn.activity", "turn.stream.delta"] as const) {
    state = reduceBridge(state, event(type, type, { turnId: "old", itemId: "late", kind: "assistant_text", textDelta: "Late", status: "started", activity: { kind: "command", command: "old", cwd: null } }));
    expect(state.activeTurnId).toBe("new"); expect(state.messages).toHaveLength(0); expect(state.error).toBeNull();
  }
});

test("a failed tool step does not prevent completed work from collapsing", () => {
  let state = reduceBridge(emptyChat(), event("start", "turn.started", { turnId: "turn" }));
  state = reduceBridge(state, event("tool1", "item.started", { turnId: "turn", item: { id: "tool", type: "activity", status: "started", activity: { kind: "command", command: "bun test", cwd: null } } }));
  state = reduceBridge(state, event("tool2", "item.completed", { turnId: "turn", item: { id: "tool", type: "activity", status: "failed", activity: { kind: "command", command: "bun test", cwd: null } } }));
  expect(state.messages).toHaveLength(1);
  state.activeTurnId = null; state.turns.turn = { status: "completed", durationMs: 1 };
  const html = render(state);
  expect(html).toContain("1 failed step");
  expect(html).toContain("progress-disclosure");
  expect(html).toContain("1 failed step");
  expect(html).not.toContain(" open=");
  expect(html.indexOf("1 failed step")).toBeLessThan(html.indexOf("</summary>"));
});

test("tool history survives reload and is not mistaken for a final answer", () => {
  const history = turn(); history.items.splice(2, 0, { id: "tool", type: "activity", status: "completed", activity: { kind: "command", command: "bun test", cwd: null } });
  const state = mergeHistory(emptyChat(), [history]);
  expect(state.messages.find((m) => m.id === "tool")?.activity?.status).toBe("completed");
  expect(timelineGroups(state).flatMap((g) => g.finalIds)).toEqual(["answer"]);
});

test("generated images stay visible, use only scoped URLs and deduplicate by item", () => {
  const imageEvent = event("image", "item.completed", { turnId: "turn", item: { id: "image", type: "image", webImage: { url: "/api/conversations/abc/images/def", prompt: "A picture" } } });
  let state = reduceBridge(emptyChat(), imageEvent);
  state = reduceBridge(state, { ...imageEvent, id: "replay" });
  expect(state.messages).toHaveLength(1);
  state.turns.turn = { status: "completed", durationMs: 1 };
  expect(render(state)).toContain('<img'); expect(render(state)).not.toContain("progress-disclosure");
  state.messages[0]!.image!.url = "https://tracking.test/image.png";
  expect(render(state)).not.toContain('<img'); expect(render(state)).toContain("unavailable");
});

test("generated images and final text share one assistant response live and after reload", () => {
  const image = { url: "/api/conversations/abc/images/def", prompt: "A white unicorn in an enchanted meadow", name: "unicorn.png" };
  let state = reduceBridge(emptyChat(), event("start", "turn.started", { turnId: "turn" }));
  state = reduceBridge(state, event("image", "item.completed", { turnId: "turn", item: { id: "image", type: "image", webImage: image } }));
  let html = render(state);
  expect(html).toContain("assistant-response");
  expect(html.indexOf("Shepherd")).toBeLessThan(html.indexOf("<img"));
  expect(html).toContain("Generation details");
  expect(html).not.toContain(" open=");
  state = reduceBridge(state, event("answer", "item.completed", { turnId: "turn", item: { id: "answer", type: "assistant_message", text: "Your unicorn is ready.", phase: "final" } }));
  html = render(state);
  expect(timelineGroups(state)).toHaveLength(1);
  expect(timelineGroups(state)[0]!.finalIds).toEqual(["image", "answer"]);
  expect(html.match(/>Shepherd</g)).toHaveLength(1);
  expect(html.indexOf("<img")).toBeLessThan(html.indexOf("Your unicorn is ready."));
  const multipart = reduceBridge(state, event("answer2", "item.completed", { turnId: "turn", item: { id: "answer2", type: "assistant_message", text: "It has a rainbow mane.", phase: "final" } }));
  expect(timelineGroups(multipart)).toHaveLength(1);
  expect(render(multipart).match(/>Shepherd</g)).toHaveLength(1);
  const history = turn();
  history.items = [{ id: "image", type: "image", webImage: image }, { id: "answer", type: "assistant_message", phase: "final", text: "Your unicorn is ready." }];
  state = mergeHistory(emptyChat(), [history]);
  html = render(state);
  expect(timelineGroups(state)).toHaveLength(1);
  expect(html.match(/>Shepherd</g)).toHaveLength(1);
  expect(html).not.toContain("progress-disclosure");
  expect(html).toContain('aria-label="Copy response"');
});

test("viewed images fold with work while images embedded in final answers stay visible", () => {
  let state = mergeHistory(emptyChat(), [turn("in_progress")]);
  state.activeTurnId = "turn";
  state = reduceBridge(state, event("view", "item.completed", { turnId: "turn", item: { id: "view", type: "image", webImage: { url: "/api/conversations/abc/images/def", prompt: null, name: "screenshot.png", path: "/tmp/screenshot.png", kind: "viewed" } } }));
  let html = render(state);
  expect(html).toContain("viewed-image-disclosure");
  expect(html).not.toContain(" open=");
  expect(html).not.toContain("progress-disclosure");
  const history = turn();
  history.items.splice(2, 0, { id: "view", type: "image", webImage: state.messages.find((message) => message.id === "view")!.image });
  history.items[3]!.text = "Here is the screenshot:\n\n![Final screenshot](/tmp/screenshot.png)";
  state = reduceBridge(state, event("end", "turn.completed", { turnId: "turn" }));
  state = mergeHistory(state, [history]);
  html = render(state);
  expect(html.match(/class="progress-disclosure"/g)).toHaveLength(1);
  expect(html).not.toContain(" open=");
  expect(html.indexOf("Viewed image · screenshot.png")).toBeLessThan(html.lastIndexOf("</details>"));
  expect(html.indexOf('alt="Final screenshot"')).toBeGreaterThan(html.lastIndexOf("</details>"));
  expect(timelineGroups(state).flatMap((group) => group.finalIds)).toEqual(["answer"]);
});

test("superseded and completed turns cannot restart from late events", () => {
  let state = reduceBridge(emptyChat(), event("start1", "turn.started", { turnId: "old" }));
  state = reduceBridge(state, event("start2", "turn.started", { turnId: "new" }));
  state = reduceBridge(state, event("late", "turn.started", { turnId: "old" }));
  expect(state.activeTurnId).toBe("new");
  state = reduceBridge(state, event("late-end", "turn.completed", { turnId: "old" }));
  expect(state.activeTurnId).toBe("new");
  state = reduceBridge(state, event("end", "turn.completed", { turnId: "new" }));
  state = reduceBridge(state, event("late2", "item.delta", { turnId: "new", itemId: "ghost", channel: "message", delta: "Late", phase: null }));
  expect(state.messages).toHaveLength(0);
});

test("a stale history snapshot cannot regress finished tool activity", () => {
  let state = reduceBridge(emptyChat(), event("tool", "item.completed", { turnId: "turn", item: { id: "tool", type: "activity", status: "failed", activity: { kind: "command", command: "bun test", cwd: null } } }));
  const history = turn("in_progress");
  history.items.push({ id: "tool", type: "activity", status: "started", activity: { kind: "command", command: "bun test", cwd: null } });
  state = mergeHistory(state, [history]);
  expect(state.messages.find((m) => m.id === "tool")?.activity?.status).toBe("failed");
});

for (const id of ["native", "local:native"]) test(`canonical user ${id} retains its Revert action`, async () => {
  const { Message } = await import("../ui/src/components/Message");
  const message = { id, turnId: "turn", role: "user" as const, text: "Request", complete: true };
  expect(renderToStaticMarkup(createElement(Message, { message, onRevert: () => {} }))).toContain("Revert from here");
  expect(renderToStaticMarkup(createElement(Message, { message: { ...message, optimistic: true }, onRevert: () => {} }))).not.toContain("Revert from here");
});

test("web history labels audio without sending its bytes or URL to the browser", () => {
  const presented = presentHistoryItem({ id: "user", type: "user_message", content: [
    { type: "audio", url: "https://example.com/a.wav" }, { type: "audio_file", path: "/tmp/a.wav" }, { type: "skill", name: "review", path: "/skills/review/SKILL.md" },
  ] }, "turn", new WebImages("conversation"));
  expect(presented).toEqual({ id: "user", type: "user_message", content: [
    { type: "audio" }, { type: "audio_file", path: "/tmp/a.wav" }, { type: "skill", name: "review", path: "/skills/review/SKILL.md" },
  ] });
});
