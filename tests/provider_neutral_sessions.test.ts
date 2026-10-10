import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Query, SDKMessage, SDKUserMessage, query } from "@anthropic-ai/claude-agent-sdk";
import { CodexSession } from "../server/providers/codex/session.js";
import { ClaudeSession } from "../server/providers/claude/session.js";
import { ClaudeThreadStore } from "../server/storage/claude_thread_store.js";
import { SessionManager } from "../server/core/session_manager.js";
import { toTextUserInput } from "../shared/protocol/user_input.js";
import { publicItemId } from "../server/providers/neutral_items.js";
import { hydrateNeutral, mergeNeutralHistory, neutralTimeline, reduceNeutralEvent } from "./helpers/neutral-chat-state.js";
import { assistantItem, fallbackItem } from "../server/providers/neutral_items.js";
import { NativeConversationSource } from "../server/providers/neutral_source.js";
import { capabilities } from "./helpers/provider_v2.js";
import { V2_BUDGETS } from "../shared/protocol/v2/budgets.js";
import type { BridgeEvent } from "../shared/protocol/v2/events.js";
import codexFixture from "./fixtures/provider-neutral/codex-text.json";
import codexRecorded from "./fixtures/provider-neutral/codex-recorded.json";
import claudeRecorded from "./fixtures/provider-neutral/claude-recorded.json";
import { ClaudeNeutralMapper } from "../server/providers/claude/neutral_mapper.js";
import { CodexNeutralMapper } from "../server/providers/codex/neutral_mapper.js";
import { ConversationProjection } from "../server/core/conversation_projection.js";
import claudeFixture from "./fixtures/provider-neutral/claude-text.json";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
type CodexInternals = { sendRequest(method: string, params?: unknown): Promise<unknown>; onNotification(method: string, params: unknown): void };

test("actual Codex session publishes native-derived v2 text whose recovered projection matches live fields", async () => {
  expect(codexFixture.evidence).toBe("synthetic");
  const session = new CodexSession("on-request");
  session.initialize = async () => {};
  const internals = session as unknown as CodexInternals;
  internals.sendRequest = async method => {
    if (method === "thread/start") return { thread: { id: "thread-1" } };
    if (method === "thread/items/list") return structuredClone(codexFixture.history);
    if (method === "thread/turns/list") return { data: [{ id: "turn-1", status: "completed", items: [] }], nextCursor: null };
    throw new Error(`Unexpected native read: ${method}`);
  };
  const manager = new SessionManager(undefined, () => session);
  await manager.createThread({});
  const snapshot = manager.readNeutralSnapshot("thread-1");
  const events: BridgeEvent[] = [];
  manager.subscribeNeutralEvents("thread-1", event => events.push(event));
  for (const frame of codexFixture.notifications) internals.onNotification(frame.method, structuredClone(frame.params));
  let state = hydrateNeutral(snapshot);
  for (const event of events) state = reduceNeutralEvent(state, event);
  const history = await manager.readNeutralItems("thread-1");
  const live = neutralTimeline(state);
  expect(history.data.map(entry => entry.item)).toEqual(live);
  expect(live.map(item => item.type)).toEqual(["user_message", "assistant_message", "assistant_message"]);
  expect(live[2]).toMatchObject({ id: publicItemId("thread-1", "answer"), phase: "final_answer", text: { text: "The fixture contains 🦊." } });
  expect(manager.readNeutralSnapshot("thread-1").state).toMatchObject({ activeTurnId: null, state: "idle" });
  state = mergeNeutralHistory(state, history);
  expect(neutralTimeline(state)).toHaveLength(3);
  expect(state.needsResync).toBe(false);
  manager.stopAll();
});

const orphanFixture = { ...claudeFixture, scenario: "unmatched tool result", messages: claudeFixture.messages.map(frame => frame.type === "user" ? { ...frame, message: { content: [{ type: "tool_result", tool_use_id: "orphan", content: "standalone result", is_error: false }] } } : frame) };
for (const fixture of [claudeFixture, claudeRecorded, orphanFixture]) test(`${fixture.evidence} Claude session (${fixture.scenario}) shares live/history identity`, async () => {
  const directory = mkdtempSync(join(tmpdir(), "shepherd-neutral-claude-")); directories.push(directory);
  const sdk = {
    query: (({ prompt }: Parameters<typeof query>[0]) => {
      const generator = (async function* () {
        for await (const _message of prompt as AsyncIterable<SDKUserMessage>) break;
        for (const frame of fixture.messages) yield structuredClone(frame) as unknown as SDKMessage;
      })();
      return Object.assign(generator, { close() {}, async interrupt() {}, async supportedModels() { return []; } }) as Query;
    }) as typeof query,
    forkSession: async () => ({ sessionId: "unused" }),
  };
  const session = new ClaudeSession("on-request", undefined, new ClaudeThreadStore(directory), sdk);
  const manager = new SessionManager(undefined, () => session);
  const { threadId } = await manager.createThread({ provider: "claude", cwd: directory });
  const snapshot = manager.readNeutralSnapshot(threadId), events: BridgeEvent[] = [];
  let resolve!: () => void;
  const ended = new Promise<void>(done => { resolve = done; });
  manager.subscribeNeutralEvents(threadId, event => { events.push(event); if (event.type === "turn.completed") resolve(); });
  await manager.submitTurn(threadId, { input: [toTextUserInput("Read the synthetic fixture.")] });
  await ended;
  let state = hydrateNeutral(snapshot);
  for (const event of events) state = reduceNeutralEvent(state, event);
  const historyItems = [];
  let cursor: string | undefined;
  do { const page = await manager.readNeutralItems(threadId, cursor); historyItems.push(...page.data.map(entry => entry.item)); cursor = page.nextCursor ?? undefined; } while (cursor);
  const live = neutralTimeline(state);
  expect(historyItems).toEqual(live);
  if (fixture === orphanFixture) expect(live).toContainEqual(expect.objectContaining({ type: "tool", name: "Tool result", output: expect.objectContaining({ text: "standalone result" }) }));
  const answers = live.filter(item => item.type === "assistant_message");
  if (fixture.evidence === "synthetic") expect(answers).toMatchObject([
    { id: publicItemId(threadId, "api-message"), phase: "commentary", text: { text: "Reading the fixture." } },
    { id: publicItemId(threadId, "api-message:1"), phase: "final_answer", text: { text: "The fixture contains 🦊." } },
  ]);
  else expect(answers).toMatchObject([{ phase: "final_answer", text: { text: claudeRecorded.messages.find(frame => frame.type === "result")!.result } }]);
  expect(state.needsResync).toBe(false);
  manager.stopAll();
});

test("large answers retain full text through an authorized asset without leaking native paths or identifiers", async () => {
  const source = new NativeConversationSource(capabilities(), async () => ({ data: [], nextCursor: null })); source.bind("thread");
  const full = "x".repeat(V2_BUDGETS.messageTextBytes + 4000);
  const item = assistantItem(source, "thread", "turn", "native-id", full, "final_answer", "completed");
  expect(item.type === "assistant_message" && item.text.truncated).toBe(true);
  expect(item.detailAsset?.media).toBe("text");
  expect(new TextDecoder().decode((await source.readAsset(item.detailAsset!.id)).bytes)).toBe(full);
  expect(JSON.stringify(item)).not.toContain("native-id");
  await expect(source.readAsset("/etc/passwd")).rejects.toThrow("unavailable");
  const other = new NativeConversationSource(capabilities(), async () => ({ data: [], nextCursor: null })); other.bind("other");
  await expect(other.readAsset(item.detailAsset!.id)).rejects.toThrow("unavailable");
  source.invalidateHistory();
  await expect(source.readAsset(item.detailAsset!.id)).rejects.toThrow("unavailable");
});

test("unmatched native output is retained as a neutral fallback, including its output", () => {
  expect(fallbackItem("thread", "turn", "orphan", "Function output", null, "standalone result", "completed")).toMatchObject({
    type: "tool", output: { text: "standalone result" }, recovery: "partial",
  });
});


test("recorded Codex sandbox failure preserves live/history text and failed tool output", () => {
  const threadId = codexRecorded.requests.find(request => request.method === "turn/start")!.params.threadId!;
  const source = new NativeConversationSource(capabilities(), async () => ({ data: [], nextCursor: null }));
  source.bind(threadId);
  const mapper = new CodexNeutralMapper(source), projection = new ConversationProjection(threadId, "session", source);
  const initial = projection.snapshot();
  for (const frame of codexRecorded.notifications) mapper.notification(frame.method, frame.params, threadId, null);
  let state = hydrateNeutral(initial);
  for (const event of projection.eventsAfter({ epoch: initial.epoch, sequence: initial.throughSequence })) state = reduceNeutralEvent(state, event);
  const actualThread = codexRecorded.requests.find(request => request.method === "turn/start")!.params.threadId!;
  const recovered = codexRecorded.history.data.map(entry => mapper.item(actualThread, entry.turnId, entry.item, "completed"));
  expect(neutralTimeline(state)).toEqual(recovered);
  expect(recovered).toContainEqual(expect.objectContaining({ type: "command", status: "failed", output: expect.objectContaining({ text: expect.stringContaining("bwrap") }) }));
  expect(state.needsResync).toBe(false);
  projection.close(); source.close();
});

test("interrupted history and provider disconnect do not claim a complete answer", () => {
  const source = new NativeConversationSource(capabilities(), async () => ({ data: [], nextCursor: null })); source.bind("thread");
  const mapper = new CodexNeutralMapper(source), projection = new ConversationProjection("thread", "session", source);
  expect(mapper.item("thread", "turn", { type: "agentMessage", id: "answer", text: "prefix" }, "interrupted")).toMatchObject({ status: "interrupted", recovery: "partial" });
  mapper.turnStarted("turn");
  mapper.notification("item/agentMessage/delta", { threadId: "thread", turnId: "turn", itemId: "answer", delta: "prefix" }, null, null);
  mapper.disconnected("thread");
  const snapshot = projection.snapshot();
  expect(snapshot.items[0].item).toMatchObject({ status: "failed", recovery: "partial", text: { text: "prefix" } });
  expect(snapshot.state).toMatchObject({ state: "error", activeTurnId: null });
  projection.close(); source.close();
});


test("a late turn/start response cannot reopen a turn completed in native notifications", () => {
  const source = new NativeConversationSource(capabilities(), async () => ({ data: [], nextCursor: null })); source.bind("thread");
  const mapper = new CodexNeutralMapper(source), projection = new ConversationProjection("thread", "session", source);
  mapper.turnStarted("turn");
  mapper.notification("turn/completed", { threadId: "thread", turn: { id: "turn", status: "completed" } }, null, null);
  const cursor = projection.cursor();
  mapper.turnStarted("turn");
  expect(projection.cursor()).toEqual(cursor);
  expect(projection.snapshot().state).toMatchObject({ activeTurnId: null, state: "idle" });
  projection.close(); source.close();
});


test("legacy shortened Claude tool output is marked incomplete with unknown native size", () => {
  const source = new NativeConversationSource(capabilities(), async () => ({ data: [], nextCursor: null })); source.bind("thread");
  const mapper = new ClaudeNeutralMapper(source);
  expect(mapper.historyItem("thread", "turn", { id: "tool", type: "mcpToolCall", tool: "Read", result: "preview\n[500 characters omitted]", status: "completed" })).toMatchObject({
    recovery: "partial", output: { truncated: true, totalBytes: null },
  });
  source.close();
});

test("large native command and diff records stay renderable within encoded item budgets", () => {
  const source = new NativeConversationSource(capabilities(), async () => ({ data: [], nextCursor: null })); source.bind("thread");
  const mapper = new CodexNeutralMapper(source);
  const command = mapper.item("thread", "turn", { id: "command", type: "commandExecution", command: "x".repeat(20000), cwd: "/workspace", aggregatedOutput: "output".repeat(20000), status: "completed", commandActions: Array.from({ length: 100 }, () => ({ type: "search", path: "🦊".repeat(1000), query: "🦊".repeat(1000) })) });
  expect(command).toMatchObject({ type: "command", omitted: { actions: 90 }, output: { truncated: true } });
  expect(JSON.stringify(command).length).toBeLessThan(V2_BUDGETS.itemBytes);
  const diff = mapper.item("thread", "turn", { id: "diff", type: "fileChange", status: "completed", changes: Array.from({ length: 50 }, () => ({ path: "🦊".repeat(2000), kind: { type: "update", move_path: null }, diff: "+line\n".repeat(10000) })) });
  expect(diff).toMatchObject({ type: "file_change", omitted: { changes: 30 } });
  expect(diff.type === "file_change" && diff.changes.every(change => change.diff?.truncated)).toBe(true);
  source.close();
});
