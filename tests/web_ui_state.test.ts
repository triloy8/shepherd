import { expect, spyOn, test } from "bun:test";
import { acceptUserMessage, type ChatMessage, emptyChat, mergeHistory, reduceBridge } from "../ui/src/chat-state";
import { readEvents, streamConversation } from "../ui/src/api";
import type { BridgeEvent } from "../shared/protocol/events";
import type { HistoryTurn } from "../shared/protocol/requests";
const event = (id: string, type: BridgeEvent["type"], payload: unknown): BridgeEvent => ({ id, type, payload, threadId: "thread", sessionId: "session", ts: "2026-01-01T00:00:00Z" });
const turn = (id: string, text: string): HistoryTurn => ({ id, items: [{ id: `user-${id}`, type: "user_message", content: [{ type: "text", text }] }], status: "completed", itemsView: "full", error: null, startedAt: null, completedAt: null, durationMs: null });

test("stream replay is deduplicated and canonical completion replaces partial text", () => {
  const delta = event("delta", "item.delta", { turnId: "turn", itemId: "item", channel: "message", delta: "Hello", phase: null });
  const partial = reduceBridge(emptyChat(), delta);
  expect(reduceBridge(partial, delta).messages[0]!.text).toBe("Hello");
  const complete = reduceBridge(partial, event("complete", "item.completed", { turnId: "turn", item: { id: "item", type: "assistant_message", text: "Hello world" } }));
  expect(complete.messages).toHaveLength(1);
  expect(complete.messages[0]!.text).toBe("Hello world");
  expect(reduceBridge(complete, { ...delta, id: "late" }).messages[0]!.text).toBe("Hello world");
});

test("history preserves older pages on refresh and reconciles optimistic messages", () => {
  let state = mergeHistory(emptyChat(), [turn("2", "new")]);
  state = mergeHistory(state, [turn("1", "old")], true);
  state.messages.push({ optimistic: true, id: "local:pending", role: "user", text: "latest", turnId: "3", complete: true });
  state = mergeHistory(state, [turn("3", "latest"), turn("2", "new")]);
  expect(state.messages.map((item) => item.text)).toEqual(["old", "new", "latest"]);
});

test("SSE parser handles split UTF-8, CRLF, comments and multiline data", async () => {
  const source = new TextEncoder().encode(': heartbeat\r\nid: cursor\r\nevent: bridge\r\ndata: {"id":"event",\r\ndata: "payload":"héllo"}\r\n\r\n');
  const events: unknown[] = [];
  await readEvents(new ReadableStream({ start(controller) { for (const byte of source) controller.enqueue(new Uint8Array([byte])); controller.close(); } }), (event) => events.push(event));
  expect(events).toEqual([{ id: "cursor", type: "bridge", data: { id: "event", payload: "héllo" } }]);
});

test("SSE parser caps unterminated input and cancels its reader", async () => {
  let cancelled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(262145))); }, cancel() { cancelled = true; } });
  await expect(readEvents(body, () => {})).rejects.toThrow("buffer limit");
  expect(cancelled).toBe(true);
});

test("switching chats discards old deltas and completions buffered in the same SSE chunk", async () => {
  const abort = new AbortController();
  const events = [
    event("first", "item.delta", { turnId: "old-turn", itemId: "old-item", channel: "message", delta: "Old chat", phase: null }),
    event("late-delta", "item.delta", { turnId: "old-turn", itemId: "old-item", channel: "message", delta: " continued", phase: null }),
    event("late-completion", "item.completed", { turnId: "old-turn", item: { id: "old-item", type: "assistant_message", text: "Old chat completed" } }),
  ];
  const chunk = events.map((data) => `event: bridge\ndata: ${JSON.stringify(data)}\n\n`).join("");
  let chat = emptyChat();
  let received = 0;
  let cancelled = false;
  await readEvents(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(chunk)); },
    cancel() { cancelled = true; },
  }), (message) => {
    if (message.type !== "bridge") return;
    received++;
    chat = reduceBridge(chat, message.data);
    // The user selects a new chat before the buffered chunk is exhausted.
    abort.abort();
    chat = emptyChat();
  }, undefined, abort.signal);
  expect(received).toBe(1);
  expect(chat.messages).toEqual([]);
  expect(cancelled).toBe(true);
});

test("aborting an idle SSE reader cancels pending reads without waiting for another chunk", async () => {
  const abort = new AbortController();
  let cancelled = false;
  let received = false;
  const pending = readEvents(new ReadableStream({ cancel() { cancelled = true; } }), () => { received = true; }, undefined, abort.signal);
  abort.abort();
  await pending;
  expect(cancelled).toBe(true);
  expect(received).toBe(false);
});

test("an old chat's delayed stream response cannot mark the new chat connected", async () => {
  const abort = new AbortController();
  let cancelled = false;
  let ready = false;
  let received = false;
  let respond!: (response: Response) => void;
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>((resolve) => { respond = resolve; }));
  try {
    const pending = streamConversation("old-chat", null, abort.signal, () => { ready = true; }, () => { received = true; });
    abort.abort();
    respond(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
    await pending;
    expect(ready).toBe(false);
    expect(received).toBe(false);
    expect(cancelled).toBe(true);
  } finally { fetchMock.mockRestore(); }
});

test("history ahead of queued stream deltas is not duplicated", () => {
  const delta = (id: string, textDelta: string) => event(id, "item.delta", { turnId: "turn", itemId: "agent", channel: "message", delta: textDelta, phase: null });
  let state = reduceBridge(emptyChat(), delta("1", "Hello"));
  state = mergeHistory(state, [{ ...turn("turn", "prompt"), status: "in_progress", items: [{ id: "agent", type: "assistant_message", text: "Hello world" }] }]);
  expect(state.messages[0]!.text).toBe("Hello world");
  state = reduceBridge(state, delta("2", " world"));
  expect(state.messages[0]!.text).toBe("Hello world");
  state = reduceBridge(state, delta("3", "!"));
  expect(state.messages[0]!.text).toBe("Hello world!");
});

test("ending a turn freezes partial messages instead of leaving a writing indicator", () => {
  const state = reduceBridge(emptyChat(), event("delta", "item.delta", { turnId: "turn", itemId: "item", channel: "message", delta: "Partial", phase: null }));
  const ended = reduceBridge(state, event("end", "turn.completed", { turnId: "turn" }));
  expect(ended.messages[0]!.complete).toBe(true);
  expect(ended.activeTurnId).toBeNull();
});

test("image-only history retains previews and only deduplicates matching optimistic attachments", () => {
  const first = "data:image/png;base64,iVBORw0KGgo=";
  const second = "data:image/gif;base64,R0lGODlh";
  const state = emptyChat();
  state.messages = [
    { optimistic: true, id: "local:first", turnId: "turn", role: "user", text: "", attachments: [first], complete: true },
    { optimistic: true, id: "local:second", turnId: "turn", role: "user", text: "", attachments: [second], complete: true },
  ];
  const history = turn("turn", "");
  history.items[0]!.content = [{ type: "image", url: first }];
  const merged = mergeHistory(state, [history]);
  expect(merged.messages).toHaveLength(2);
  expect(merged.messages[0]!.attachments).toEqual([first]);
  expect(merged.messages[1]!.id).toBe("local:second");
  history.items[0]!.content = [{ type: "image", url: "https://untrusted.test/pixel" }];
  const unavailable = mergeHistory(emptyChat(), [history]);
  expect(unavailable.messages[0]!.attachments).toEqual([]);
  expect(unavailable.messages[0]!.text).toContain("unavailable");
});

const sentUser = (id: string, attachments: string[] = []): ChatMessage => ({ id, turnId: "same-turn", role: "user", text: "Again", attachments, complete: true });
const repeatedTurn = (ids: string[]): HistoryTurn => ({ ...turn("same-turn", "Again"), items: ids.map((id) => ({ id, type: "user_message", content: [{ type: "text", text: "Again" }] })) });

test("a delayed send receipt does not duplicate its canonical history message", () => {
  const before = mergeHistory(emptyChat(), [repeatedTurn(["first"])]);
  const after = mergeHistory(before, [repeatedTurn(["first", "second"])]);
  expect(acceptUserMessage(after, sentUser("local:second"), before.messages).messages.map((item) => item.id)).toEqual(["first", "second"]);
});

test("an earlier identical follow-up cannot reconcile a new optimistic message", () => {
  const before = mergeHistory(emptyChat(), [repeatedTurn(["first"])]);
  const pending = acceptUserMessage(before, sentUser("local:second"), before.messages);
  expect(mergeHistory(pending, [repeatedTurn(["first"])]).messages.map((item) => item.id)).toEqual(["first", "local:second"]);
  expect(mergeHistory(pending, [repeatedTurn(["first", "second"])]).messages.map((item) => item.id)).toEqual(["first", "second"]);
});

test("identical optimistic follow-ups reconcile one occurrence at a time", () => {
  const first = acceptUserMessage(emptyChat(), sentUser("local:first"), []);
  const second = acceptUserMessage(first, sentUser("local:second"), first.messages);
  const partial = mergeHistory(second, [repeatedTurn(["first"])]);
  expect(partial.messages.map((item) => item.id)).toEqual(["first", "local:second"]);
  expect(mergeHistory(partial, [repeatedTurn(["first", "second"])]).messages.map((item) => item.id)).toEqual(["first", "second"]);
});

test("receipt reconciliation distinguishes attachments and turn identity", () => {
  const state = { ...emptyChat(), messages: [sentUser("other-image", ["image-a"]), { ...sentUser("other-turn"), turnId: "older-turn" }] };
  expect(acceptUserMessage(state, sentUser("local:new", ["image-b"]), []).messages).toHaveLength(3);
});

test("reused native item IDs survive older pages, refresh and new-turn streaming", () => {
  const answer = (id: string, value: string): HistoryTurn => ({ ...turn(id, `Question ${value}`), items: [
    { id: "user", type: "user_message", content: [{ type: "text", text: `Question ${value}` }] },
    { id: "answer", type: "assistant_message", text: `Answer ${value}`, phase: "final" },
  ] });
  let state = mergeHistory(emptyChat(), [answer("new", "new")]);
  state = mergeHistory(state, [answer("old", "old")], true);
  state = mergeHistory(state, [answer("new", "new")]);
  expect(state.messages.map(message => [message.turnId, message.text])).toEqual([
    ["old", "Question old"], ["old", "Answer old"], ["new", "Question new"], ["new", "Answer new"],
  ]);
  state = reduceBridge(state, event("start", "turn.started", { turnId: "next" }));
  state = reduceBridge(state, event("delta", "item.delta", { turnId: "next", itemId: "answer", channel: "message", delta: "Next partial", phase: "final" }));
  state = reduceBridge(state, event("complete", "item.completed", { turnId: "next", item: { id: "answer", type: "assistant_message", text: "Next canonical", phase: "final" } }));
  expect(state.messages.filter(message => message.id === "answer").map(message => message.text)).toEqual(["Answer old", "Answer new", "Next canonical"]);
});

for (const reportedPhase of ["final", "interim", null] as const) test(`anonymous web text adopts canonical identity and phase ${reportedPhase}`, () => {
  let state = reduceBridge(emptyChat(), event("start", "turn.started", { turnId: "turn" }));
  const first = event("first", "item.delta", { turnId: null, itemId: null, channel: "message", delta: "Hello", phase: reportedPhase });
  state = reduceBridge(state, first); state = reduceBridge(state, first);
  state = reduceBridge(state, event("next", "item.delta", { turnId: "turn", itemId: null, channel: "message", delta: " world", phase: null }));
  expect(state.messages).toHaveLength(1); expect(state.messages[0]!.text).toBe("Hello world");
  state = reduceBridge(state, event("complete", "item.completed", { turnId: null, item: { id: "canonical", type: "assistant_message", text: "Canonical answer" } }));
  expect(state.messages).toHaveLength(1); expect(state.messages[0]).toMatchObject({ id: "canonical", turnId: "turn", text: "Canonical answer", complete: true, anonymous: false });
  expect(state.messages[0]!.phase).toBe(reportedPhase ?? undefined);
  state = reduceBridge(state, event("late", "item.delta", { turnId: "turn", itemId: "canonical", channel: "message", delta: "ignored", phase: null }));
  expect(state.messages[0]!.text).toBe("Canonical answer");
});

test("identified and anonymous deltas can alternate before canonical completion", () => {
  let state = reduceBridge(emptyChat(), event("start", "turn.started", { turnId: "turn" }));
  for (const [index, itemId] of [null, "canonical", null, "canonical"].entries()) state = reduceBridge(state, event(String(index), "item.delta", { turnId: "turn", itemId: itemId, channel: "message", delta: String(index), phase: "final" }));
  expect(state.messages).toHaveLength(1); expect(state.messages[0]).toMatchObject({ id: "canonical", text: "0123", anonymous: false });
});

test("history identifies anonymous streams without duplicating queued replay", () => {
  let state = reduceBridge(emptyChat(), event("start", "turn.started", { turnId: "turn" }));
  state = reduceBridge(state, event("first", "item.delta", { turnId: "turn", itemId: null, channel: "message", delta: "Hello", phase: "final" }));
  const history: HistoryTurn = { ...turn("turn", "Question"), status: "in_progress", items: [{ id: "canonical", type: "assistant_message", phase: "final", text: "Hello world" }] };
  state = mergeHistory(state, [history]);
  state = reduceBridge(state, event("second", "item.delta", { turnId: null, itemId: null, channel: "message", delta: " world", phase: null }));
  expect(state.messages).toHaveLength(1); expect(state.messages[0]).toMatchObject({ id: "canonical", text: "Hello world" });
  state = reduceBridge(state, event("complete", "item.completed", { turnId: null, item: { id: "canonical", type: "assistant_message", text: "Hello world" } }));
  state = mergeHistory(state, [{ ...history, status: "completed" }]);
  expect(state.messages).toHaveLength(1); expect(state.messages[0]!.text).toBe("Hello world");
});

for (const terminal of ["turn.completed", "turn.failed"] as const) test(`null ${terminal} settles the current turn while identified late events stay isolated`, () => {
  let state = reduceBridge(emptyChat(), event("start", "turn.started", { turnId: "current" }));
  state = reduceBridge(state, event("activity", "item.started", { turnId: null, item: { id: "tool", type: "activity", status: "started", activity: { kind: "command", command: null, cwd: null } } }));
  state = reduceBridge(state, event("text", "item.delta", { turnId: null, itemId: "answer", channel: "message", delta: "Partial answer", phase: "final" }));
  state = reduceBridge(state, event("foreign", "turn.failed", { turnId: "earlier", message: "Foreign failure" }));
  expect(state.activeTurnId).toBe("current"); expect(state.error).toBeNull();
  state = reduceBridge(state, event("terminal", terminal, { turnId: null, message: "Current failure" }));
  expect(state.activeTurnId).toBeNull(); expect(state.activity).toBeNull(); expect(state.endedTurns).toContain("current");
  expect(state.messages.every(message => message.turnId === "current" && message.complete)).toBe(true);
  expect(state.error).toBe(terminal === "turn.failed" ? "Current failure" : null);
});

test("identified completion resolves an anonymous stream retained by an ambiguous snapshot", () => {
  let state = reduceBridge(emptyChat(), event("start", "turn.started", { turnId: "turn" }));
  state = reduceBridge(state, event("first", "item.delta", { turnId: "turn", itemId: null, channel: "message", delta: "Hello", phase: null }));
  const history: HistoryTurn = { ...turn("turn", "Question"), status: "in_progress", items: [
    { id: "progress", type: "assistant_message", phase: "interim", text: "Hello from progress" },
    { id: "answer", type: "assistant_message", phase: "final", text: "Hello from answer" },
  ] };
  state = mergeHistory(state, [history]);
  expect(state.messages).toHaveLength(3);
  state = reduceBridge(state, event("canonical", "item.completed", { turnId: "turn", item: { id: "answer", type: "assistant_message", text: "Hello from answer", phase: "final" } }));
  expect(state.messages).toHaveLength(2);
  expect(state.messages.some(message => message.anonymous)).toBe(false);
  expect(state.messages.map(message => message.text)).toEqual(["Hello from progress", "Hello from answer"]);
});

for (const turnId of ["constructor", "toString", "__proto__"]) test(`opaque turn ID ${turnId} streams and settles normally`, () => {
  let state = reduceBridge(emptyChat(), event("s", "turn.started", { turnId }));
  expect(state.activeTurnId).toBe(turnId);
  state = reduceBridge(state, event("d", "item.delta", { turnId: turnId, itemId: "a", channel: "message", delta: "Answer", phase: null }));
  state = reduceBridge(state, event("c", "turn.completed", { turnId: null }));
  expect(state.messages).toHaveLength(1);
  expect(state.messages[0]).toMatchObject({ turnId, text: "Answer", complete: true });
  expect(state.activeTurnId).toBeNull();
  expect(Object.hasOwn(state.turns, turnId)).toBe(true);
});

test("a repeated anonymous message cannot claim an established answer through snapshots or replay", () => {
  let state = reduceBridge(emptyChat(), event("s", "turn.started", { turnId: "t" }));
  state = reduceBridge(state, event("a", "item.completed", { turnId: "t", item: { id: "a", type: "assistant_message", text: "Hello" } }));
  state = reduceBridge(state, event("d", "item.delta", { turnId: "t", itemId: null, channel: "message", delta: "Hello", phase: null }));
  state = mergeHistory(state, [{ ...turn("t", ""), status: "in_progress", items: [{ id: "a", type: "assistant_message", text: "Hello" }] }]);
  state = reduceBridge(state, event("a-replay", "item.completed", { turnId: "t", item: { id: "a", type: "assistant_message", text: "Hello" } }));
  expect(state.messages).toHaveLength(2);
  expect(state.messages[0]).toMatchObject({ id: "a", text: "Hello", complete: true });
  expect(state.messages[1]!.anonymous).toBe(true);
  state = reduceBridge(state, event("more", "item.delta", { turnId: "t", itemId: null, channel: "message", delta: " again", phase: null }));
  state = reduceBridge(state, event("b", "item.completed", { turnId: "t", item: { id: "b", type: "assistant_message", text: "Hello again" } }));
  expect(state.messages.map(message => [message.id, message.text])).toEqual([["a", "Hello"], ["b", "Hello again"]]);
});

test("native local-prefixed user and assistant IDs remain canonical and chronologically ordered", () => {
  const native = mergeHistory(emptyChat(), [repeatedTurn(["local:native"])]);
  expect(acceptUserMessage(native, sentUser("receipt"), []).messages).toEqual(native.messages);
  const optimistic = acceptUserMessage(native, sentUser("opaque-optimistic"), native.messages);
  expect(optimistic.messages.at(-1)!.optimistic).toBe(true);
  expect(mergeHistory(optimistic, [repeatedTurn(["local:native", "local:second"])]).messages.map(message => message.id)).toEqual(["local:native", "local:second"]);
  const previous = { ...turn("old", ""), items: [{ id: "local:answer", type: "assistant_message" as const, text: "Old answer" }] };
  const refreshed = mergeHistory(mergeHistory(emptyChat(), [previous]), [turn("new", "New request")]);
  expect(refreshed.messages.map(message => message.text)).toEqual(["Old answer", "New request"]);
});

test("attachment-only and mixed history messages retain names or unavailable placeholders", () => {
  const history = { ...turn("t", ""), items: [{ id: "u", type: "user_message" as const, content: [
    { type: "attachment" as const, name: "recording.wav", path: "/tmp/recording.wav" },
    { type: "attachment" as const, name: null, path: null },
  ] }] };
  expect(mergeHistory(emptyChat(), [history]).messages[0]!.text).toBe("[Attachment: recording.wav]\n[Attachment: unavailable]");
});

test("audio and skill inputs in history keep labels rather than becoming generic attachments", () => {
  const history = { ...turn("t", ""), items: [{ id: "u", type: "user_message" as const, content: [
    { type: "audio" as const }, { type: "audio_file" as const, path: "/tmp/a.wav" }, { type: "skill" as const, name: "review", path: "/skills/review/SKILL.md" },
  ] }] };
  expect(mergeHistory(emptyChat(), [history]).messages[0]!.text).toBe("[Audio attachment]\n[Audio attachment]\n[Skill: review]");
});

test("plans and reasoning stream as running steps until their canonical item completes", () => {
  const delta = (id: string, channel: string, text: string, extra: object = {}) => event(id, "item.delta", { turnId: "turn", itemId: "reason", channel, delta: text, phase: null, ...extra });
  let state = reduceBridge(emptyChat(), event("start", "turn.started", { turnId: "turn" }));
  state = reduceBridge(state, delta("d1", "reasoning", "Checking"));
  state = reduceBridge(state, delta("d2", "reasoning", " the logs"));
  state = reduceBridge(state, delta("d3", "reasoning", "Then tests", { part: 1 }));
  expect(state.messages).toHaveLength(1);
  expect(state.messages[0]!.activity).toEqual({ status: "started", activity: { kind: "other", title: "Reasoning summary", detail: "Checking the logs\n\nThen tests" } });
  // A history snapshot taken mid-stream does not drop what streamed.
  state = mergeHistory(state, [{ id: "turn", items: [{ id: "reason", type: "reasoning", form: "summary", parts: ["Check"] }], status: "in_progress", itemsView: "full", error: null, startedAt: null, completedAt: null, durationMs: null }]);
  expect(state.messages[0]!.activity?.activity).toMatchObject({ detail: "Checking the logs\n\nThen tests" });
  state = reduceBridge(state, event("done", "item.completed", { turnId: "turn", item: { id: "reason", type: "reasoning", form: "summary", parts: ["Checked the logs."] } }));
  expect(state.messages).toHaveLength(1);
  expect(state.messages[0]!.activity).toEqual({ status: "completed", activity: { kind: "other", title: "Reasoning summary", detail: "Checked the logs." } });
  expect(state.messages[0]!.streamed).toBeUndefined();
  // Late deltas never reopen a completed item; deltas without an item have nothing to extend.
  expect(reduceBridge(state, delta("late", "reasoning", "more"))).toMatchObject({ messages: state.messages });
  expect(reduceBridge(state, event("anon", "item.delta", { turnId: "turn", itemId: null, channel: "plan", delta: "x", phase: null })).messages).toEqual(state.messages);
});

test("a running step shows its latest output, which history does not keep", () => {
  let state = reduceBridge(emptyChat(), event("start", "turn.started", { turnId: "turn" }));
  const command = { id: "cmd", type: "activity", activity: { kind: "command", command: "bun test", cwd: null } };
  state = reduceBridge(state, event("s", "item.started", { turnId: "turn", item: { ...command, status: "started" } }));
  state = reduceBridge(state, event("o1", "item.delta", { turnId: "turn", itemId: "cmd", channel: "output", delta: "1 pass\n", phase: null }));
  state = reduceBridge(state, event("o2", "item.delta", { turnId: "turn", itemId: "cmd", channel: "output", delta: "2 pass\n", phase: null }));
  expect(state.messages[0]!.output).toBe("1 pass\n2 pass\n");
  state = reduceBridge(state, event("c", "item.completed", { turnId: "turn", item: { ...command, status: "completed" } }));
  expect(state.messages[0]!.output).toBeUndefined();
  expect(reduceBridge(state, event("o3", "item.delta", { turnId: "turn", itemId: "cmd", channel: "output", delta: "late", phase: null })).messages[0]!.output).toBeUndefined();
});

test("an interrupted turn is labelled interrupted as soon as it ends", () => {
  let state = reduceBridge(emptyChat(), event("start", "turn.started", { turnId: "turn" }));
  state = reduceBridge(state, event("end", "turn.completed", { turnId: "turn", interrupted: true }));
  expect(state.turns.turn?.status).toBe("interrupted");
  expect(state.activeTurnId).toBeNull();
  const completed = reduceBridge(reduceBridge(emptyChat(), event("s2", "turn.started", { turnId: "other" })), event("e2", "turn.completed", { turnId: "other" }));
  expect(completed.turns.other?.status).toBe("in_progress");
});

test("a live message history lacks stays in its own turn rather than moving below later turns", () => {
  const user = (turnId: string, text: string) => ({ id: `user-${turnId}`, type: "user_message" as const, content: [{ type: "text" as const, text }] });
  const turnOf = (id: string, items: HistoryTurn["items"]): HistoryTurn => ({ id, items, status: "completed", itemsView: "full", error: null, startedAt: null, completedAt: null, durationMs: null });
  // The first turn's answer streamed live, but a restart cut the turn off before it was recorded.
  let state = mergeHistory(emptyChat(), [{ ...turnOf("t1", [user("t1", "merge it")]), status: "in_progress" }]);
  state = reduceBridge(state, event("s1", "turn.started", { turnId: "t1" }));
  state = reduceBridge(state, event("a1", "item.completed", { turnId: "t1", item: { id: "lost", type: "assistant_message", text: "Merged.", phase: "final" } }));
  state = reduceBridge(state, event("e1", "turn.completed", { turnId: "t1" }));
  state = mergeHistory(state, [
    turnOf("t2", [user("t2", "what next?"), { id: "next", type: "assistant_message", text: "Discord.", phase: "final" }]),
    turnOf("t1", [user("t1", "merge it"), { id: "placeholder", type: "assistant_message", text: "No response requested.", phase: "final" }]),
  ]);
  expect(state.messages.map((message) => message.id)).toEqual(["user-t1", "placeholder", "lost", "user-t2", "next"]);
  // A turn history does not include yet still follows the history it has.
  state = reduceBridge(state, event("s3", "turn.started", { turnId: "t3" }));
  state = reduceBridge(state, event("d3", "item.delta", { turnId: "t3", itemId: "streaming", channel: "message", delta: "Work", phase: null }));
  state = mergeHistory(state, [turnOf("t2", [user("t2", "what next?"), { id: "next", type: "assistant_message", text: "Discord.", phase: "final" }])]);
  expect(state.messages.at(-1)?.id).toBe("streaming");
});
