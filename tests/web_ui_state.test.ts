import { expect, spyOn, test } from "bun:test";
import { acceptUserMessage, type ChatMessage, emptyChat, mergeHistory, reduceBridge } from "../ui/src/chat-state";
import { readEvents, streamConversation } from "../ui/src/api";
import type { BridgeEvent } from "../shared/protocol/events";
import type { HistoryTurn } from "../shared/protocol/requests";
const event = (id: string, type: BridgeEvent["type"], payload: unknown): BridgeEvent => ({ id, type, payload, threadId: "thread", sessionId: "session", ts: "2026-01-01T00:00:00Z" });
const turn = (id: string, text: string): HistoryTurn => ({ id, items: [{ id: `user-${id}`, type: "user_message", content: [{ type: "text", text }] }], status: "completed", itemsView: "full", error: null, startedAt: null, completedAt: null, durationMs: null });

test("stream replay is deduplicated and canonical completion replaces partial text", () => {
  const delta = event("delta", "turn.stream.delta", { kind: "assistant_text", itemId: "item", turnId: "turn", textDelta: "Hello" });
  const partial = reduceBridge(emptyChat(), delta);
  expect(reduceBridge(partial, delta).messages[0]!.text).toBe("Hello");
  const complete = reduceBridge(partial, event("complete", "turn.message.completed", { itemId: "item", turnId: "turn", text: "Hello world" }));
  expect(complete.messages).toHaveLength(1);
  expect(complete.messages[0]!.text).toBe("Hello world");
  expect(reduceBridge(complete, { ...delta, id: "late" }).messages[0]!.text).toBe("Hello world");
});

test("history preserves older pages on refresh and reconciles optimistic messages", () => {
  let state = mergeHistory(emptyChat(), [turn("2", "new")]);
  state = mergeHistory(state, [turn("1", "old")], true);
  state.messages.push({ id: "local:pending", role: "user", text: "latest", turnId: "3", complete: true });
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
    event("first", "turn.stream.delta", { kind: "assistant_text", itemId: "old-item", turnId: "old-turn", textDelta: "Old chat" }),
    event("late-delta", "turn.stream.delta", { kind: "assistant_text", itemId: "old-item", turnId: "old-turn", textDelta: " continued" }),
    event("late-completion", "turn.message.completed", { itemId: "old-item", turnId: "old-turn", text: "Old chat completed" }),
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
  const delta = (id: string, textDelta: string) => event(id, "turn.stream.delta", { kind: "assistant_text", itemId: "agent", turnId: "turn", textDelta });
  let state = reduceBridge(emptyChat(), delta("1", "Hello"));
  state = mergeHistory(state, [{ ...turn("turn", "prompt"), status: "in_progress", items: [{ id: "agent", type: "assistant_message", text: "Hello world" }] }]);
  expect(state.messages[0]!.text).toBe("Hello world");
  state = reduceBridge(state, delta("2", " world"));
  expect(state.messages[0]!.text).toBe("Hello world");
  state = reduceBridge(state, delta("3", "!"));
  expect(state.messages[0]!.text).toBe("Hello world!");
});

test("ending a turn freezes partial messages instead of leaving a writing indicator", () => {
  const state = reduceBridge(emptyChat(), event("delta", "turn.stream.delta", { kind: "assistant_text", itemId: "item", turnId: "turn", textDelta: "Partial" }));
  const ended = reduceBridge(state, event("end", "turn.completed", { turnId: "turn" }));
  expect(ended.messages[0]!.complete).toBe(true);
  expect(ended.activeTurnId).toBeNull();
});

test("image-only history retains previews and only deduplicates matching optimistic attachments", () => {
  const first = "data:image/png;base64,iVBORw0KGgo=";
  const second = "data:image/gif;base64,R0lGODlh";
  const state = emptyChat();
  state.messages = [
    { id: "local:first", turnId: "turn", role: "user", text: "", attachments: [first], complete: true },
    { id: "local:second", turnId: "turn", role: "user", text: "", attachments: [second], complete: true },
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
  state = reduceBridge(state, event("delta", "turn.stream.delta", { turnId: "next", itemId: "answer", kind: "assistant_text", phase: "final", textDelta: "Next partial" }));
  state = reduceBridge(state, event("complete", "turn.message.completed", { turnId: "next", itemId: "answer", phase: "final", text: "Next canonical" }));
  expect(state.messages.filter(message => message.id === "answer").map(message => message.text)).toEqual(["Answer old", "Answer new", "Next canonical"]);
});

for (const reportedPhase of ["final", "interim", null] as const) test(`anonymous web text adopts canonical identity and phase ${reportedPhase}`, () => {
  let state = reduceBridge(emptyChat(), event("start", "turn.started", { turnId: "turn" }));
  const first = event("first", "turn.stream.delta", { turnId: null, itemId: null, kind: "assistant_text", phase: reportedPhase, textDelta: "Hello" });
  state = reduceBridge(state, first); state = reduceBridge(state, first);
  state = reduceBridge(state, event("next", "turn.stream.delta", { turnId: "turn", itemId: null, kind: "assistant_text", phase: null, textDelta: " world" }));
  expect(state.messages).toHaveLength(1); expect(state.messages[0]!.text).toBe("Hello world");
  state = reduceBridge(state, event("complete", "turn.message.completed", { turnId: null, itemId: "canonical", phase: null, text: "Canonical answer" }));
  expect(state.messages).toHaveLength(1); expect(state.messages[0]).toMatchObject({ id: "canonical", turnId: "turn", text: "Canonical answer", complete: true, anonymous: false });
  expect(state.messages[0]!.phase).toBe(reportedPhase ?? undefined);
  state = reduceBridge(state, event("late", "turn.stream.delta", { turnId: "turn", itemId: "canonical", kind: "assistant_text", textDelta: "ignored" }));
  expect(state.messages[0]!.text).toBe("Canonical answer");
});

test("identified and anonymous deltas can alternate before canonical completion", () => {
  let state = reduceBridge(emptyChat(), event("start", "turn.started", { turnId: "turn" }));
  for (const [index, itemId] of [null, "canonical", null, "canonical"].entries()) state = reduceBridge(state, event(String(index), "turn.stream.delta", { turnId: "turn", itemId, kind: "assistant_text", phase: "final", textDelta: String(index) }));
  expect(state.messages).toHaveLength(1); expect(state.messages[0]).toMatchObject({ id: "canonical", text: "0123", anonymous: false });
});

test("history identifies anonymous streams without duplicating queued replay", () => {
  let state = reduceBridge(emptyChat(), event("start", "turn.started", { turnId: "turn" }));
  state = reduceBridge(state, event("first", "turn.stream.delta", { turnId: "turn", itemId: null, kind: "assistant_text", phase: "final", textDelta: "Hello" }));
  const history: HistoryTurn = { ...turn("turn", "Question"), status: "in_progress", items: [{ id: "canonical", type: "assistant_message", phase: "final", text: "Hello world" }] };
  state = mergeHistory(state, [history]);
  state = reduceBridge(state, event("second", "turn.stream.delta", { turnId: null, itemId: null, kind: "assistant_text", phase: null, textDelta: " world" }));
  expect(state.messages).toHaveLength(1); expect(state.messages[0]).toMatchObject({ id: "canonical", text: "Hello world" });
  state = reduceBridge(state, event("complete", "turn.message.completed", { turnId: null, itemId: "canonical", phase: null, text: "Hello world" }));
  state = mergeHistory(state, [{ ...history, status: "completed" }]);
  expect(state.messages).toHaveLength(1); expect(state.messages[0]!.text).toBe("Hello world");
});

for (const terminal of ["turn.completed", "turn.failed"] as const) test(`null ${terminal} settles the current turn while identified late events stay isolated`, () => {
  let state = reduceBridge(emptyChat(), event("start", "turn.started", { turnId: "current" }));
  state = reduceBridge(state, event("activity", "turn.activity", { turnId: null, itemId: "tool", kind: "command", label: "Working", detail: null, status: "started" }));
  state = reduceBridge(state, event("text", "turn.stream.delta", { turnId: null, itemId: "answer", kind: "assistant_text", phase: "final", textDelta: "Partial answer" }));
  state = reduceBridge(state, event("foreign", "turn.failed", { turnId: "earlier", message: "Foreign failure" }));
  expect(state.activeTurnId).toBe("current"); expect(state.error).toBeNull();
  state = reduceBridge(state, event("terminal", terminal, { turnId: null, message: "Current failure" }));
  expect(state.activeTurnId).toBeNull(); expect(state.activity).toBeNull(); expect(state.endedTurns).toContain("current");
  expect(state.messages.every(message => message.turnId === "current" && message.complete)).toBe(true);
  expect(state.error).toBe(terminal === "turn.failed" ? "Current failure" : null);
});

test("identified completion resolves an anonymous stream retained by an ambiguous snapshot", () => {
  let state = reduceBridge(emptyChat(), event("start", "turn.started", { turnId: "turn" }));
  state = reduceBridge(state, event("first", "turn.stream.delta", { turnId: "turn", itemId: null, kind: "assistant_text", phase: null, textDelta: "Hello" }));
  const history: HistoryTurn = { ...turn("turn", "Question"), status: "in_progress", items: [
    { id: "progress", type: "assistant_message", phase: "interim", text: "Hello from progress" },
    { id: "answer", type: "assistant_message", phase: "final", text: "Hello from answer" },
  ] };
  state = mergeHistory(state, [history]);
  expect(state.messages).toHaveLength(3);
  state = reduceBridge(state, event("canonical", "turn.message.completed", { turnId: "turn", itemId: "answer", phase: "final", text: "Hello from answer" }));
  expect(state.messages).toHaveLength(2);
  expect(state.messages.some(message => message.anonymous)).toBe(false);
  expect(state.messages.map(message => message.text)).toEqual(["Hello from progress", "Hello from answer"]);
});
