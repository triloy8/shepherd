import { expect, spyOn, test } from "bun:test";
import { emptyChat, mergeHistory, reduceBridge } from "../ui/src/chat-state";
import { readEvents, streamConversation } from "../ui/src/api";
import type { BridgeEvent } from "../shared/protocol/events";
import type { HistoryTurn } from "../shared/protocol/requests";
const event = (id: string, type: BridgeEvent["type"], payload: unknown): BridgeEvent => ({ id, type, payload, threadId: "thread", sessionId: "session", ts: "2026-01-01T00:00:00Z" });
const turn = (id: string, text: string): HistoryTurn => ({ id, items: [{ id: `user-${id}`, type: "userMessage", content: [{ type: "text", text }] }], status: "completed", itemsView: "full", error: null, startedAt: null, completedAt: null, durationMs: null });

test("stream replay is deduplicated and canonical completion replaces partial text", () => {
  const delta = event("delta", "turn.stream.delta", { method: "item/agentMessage/delta", itemId: "item", turnId: "turn", textDelta: "Hello" });
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
    event("first", "turn.stream.delta", { method: "item/agentMessage/delta", itemId: "old-item", turnId: "old-turn", textDelta: "Old chat" }),
    event("late-delta", "turn.stream.delta", { method: "item/agentMessage/delta", itemId: "old-item", turnId: "old-turn", textDelta: " continued" }),
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
  const delta = (id: string, textDelta: string) => event(id, "turn.stream.delta", { method: "item/agentMessage/delta", itemId: "agent", turnId: "turn", textDelta });
  let state = reduceBridge(emptyChat(), delta("1", "Hello"));
  state = mergeHistory(state, [{ ...turn("turn", "prompt"), status: "inProgress", items: [{ id: "agent", type: "agentMessage", text: "Hello world" }] }]);
  expect(state.messages[0]!.text).toBe("Hello world");
  state = reduceBridge(state, delta("2", " world"));
  expect(state.messages[0]!.text).toBe("Hello world");
  state = reduceBridge(state, delta("3", "!"));
  expect(state.messages[0]!.text).toBe("Hello world!");
});

test("ending a turn freezes partial messages instead of leaving a writing indicator", () => {
  const state = reduceBridge(emptyChat(), event("delta", "turn.stream.delta", { method: "item/agentMessage/delta", itemId: "item", turnId: "turn", textDelta: "Partial" }));
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
