import { ClaudeThreadStore } from "../server/storage/claude_thread_store.js";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { query, Query, SDKMessage, SDKUserMessage, PermissionResult, Options, CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSession } from "../server/providers/claude/session.js";
import { SessionManager } from "../server/core/session_manager.js";
import { CodexSession } from "../server/providers/codex/session.js";
import { DynamicToolRegistry } from "../server/core/dynamic_tool_registry.js";
import { toTextUserInput } from "../shared/protocol/user_input.js";
import type { BridgeEvent } from "../shared/protocol/events.js";
import { validateCreateThreadRequest } from "../shared/protocol/validation.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { reduceBridge, emptyChat } from "../ui/src/chat-state.js";
import { timelineGroups } from "../ui/src/timeline.js";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function store() { const directory = mkdtempSync(join(tmpdir(), "shepherd-claude-test-")); directories.push(directory); return new ClaudeThreadStore(directory); }
function signal() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
const result = { type: "result", subtype: "success", is_error: false, result: "Hello", usage: { input_tokens: 4, output_tokens: 3 }, modelUsage: { sonnet: { inputTokens: 4, outputTokens: 3, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } } as SDKMessage;
function sdk(script: (input: AsyncIterable<SDKUserMessage>, options: Options) => AsyncGenerator<SDKMessage>) {
  const calls: Array<{ options: Options; input: AsyncIterable<SDKUserMessage> }> = [];
  let closed = 0;
  let interruptions = 0;
  let interrupt = () => {};
  const queryFn = (({ prompt, options }: Parameters<typeof query>[0]) => {
    const input = prompt as AsyncIterable<SDKUserMessage>;
    calls.push({ options: options!, input });
    return Object.assign(script(input, options!), { close: () => { closed++; }, interrupt: async () => { interruptions++; interrupt(); }, supportedModels: async () => [{ value: "sonnet", displayName: "Sonnet", description: "Claude", supportsEffort: true, supportedEffortLevels: ["low", "high"] }] }) as Query;
  }) as typeof query;
  const forks: unknown[][] = [];
  return { query: queryFn, forkSession: async (...args: unknown[]) => { forks.push(args); return { sessionId: "12345678-1234-1234-1234-123456789abc" }; }, forks, calls, closed: () => closed, interruptions: () => interruptions, onInterrupt: (fn: () => void) => { interrupt = fn; } };
}
async function done(session: ClaudeSession) {
  if (!session.activeTurnId) return;
  await new Promise<void>((resolve) => {
    const unsub = session.eventBus.subscribe((event) => { if (event.type === "turn.completed" || event.type === "turn.failed") { unsub(); resolve(); } }, { replay: false });
  });
}

test("Claude streams common events and resumes with the native session in its saved workspace", async () => {
  const storage = store();
  const fake = sdk(async function* (input, options) {
    for await (const message of input) { expect(message.message.role).toBe("user"); break; }
    yield { type: "system", subtype: "init", session_id: options.resume ?? options.sessionId } as SDKMessage;
    yield { type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id: "msg-1" } } } as SDKMessage;
    yield { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } } } as SDKMessage;
    yield { type: "assistant", parent_tool_use_id: null, message: { id: "msg-1", content: [{ type: "text", text: "Hello" }] } } as SDKMessage;
    yield result;
  });
  const session = new ClaudeSession("on-request", undefined, storage, fake);
  const created = await session.startThread({ cwd: "/old" });
  session.setCwd("/project");
  const events: BridgeEvent[] = []; session.eventBus.subscribe((event) => events.push(event), { replay: false });
  const turnId = await session.startTurn([toTextUserInput("hello")]); await done(session);
  expect(fake.calls[0]!.options.env).toBeDefined();
  if (process.env.CLAUDE_AUTH_MODE !== "api") {
    expect(fake.calls[0]!.options.env!.ANTHROPIC_API_KEY).toBe("");
    expect(fake.calls[0]!.options.settings).toMatchObject({ forceLoginMethod: "claudeai", apiKeyHelper: "" });
  }
  expect(events.map((e) => e.type)).toEqual(["turn.started", "turn.stream.delta", "turn.message.completed", "thread.tokenUsage.updated", "turn.completed"]);
  const chat = events.reduce(reduceBridge, emptyChat());
  expect(chat.messages.filter((message) => message.role === "assistant")).toMatchObject([{ text: "Hello", complete: true }]);
  expect(events[1]!.payload).toMatchObject({ kind: "assistant_text", phase: null, itemId: "msg-1", textDelta: "Hello", turnId });
  expect((await session.listThreadTurns(created.threadId, {})).data[0]).toMatchObject({ status: "completed", items: [{ type: "userMessage" }, { type: "agentMessage", text: "Hello" }] });
  const resumed = new ClaudeSession("on-request", undefined, storage, fake);
  await resumed.resumeThread(created.threadId, {});
  await resumed.startTurn([toTextUserInput("again")]); await done(resumed);
  expect(fake.calls[1]!.options).toMatchObject({ cwd: "/project", resume: created.threadId.slice(7) });
  expect((await resumed.listThreadTurns(created.threadId, { limit: 1 })).nextCursor).toBe("1");
  await resumed.archiveThread(created.threadId);
  expect((await resumed.listStoredThreads({ archived: true })).data).toHaveLength(1);
  await resumed.unarchiveThread(created.threadId);
  await resumed.setThreadName(created.threadId, "Saved");
  expect(await resumed.readThread(created.threadId, false)).toMatchObject({ thread: { name: "Saved", cwd: "/project" } });
  session.stop(); resumed.stop();
});

test("Claude approvals apply decisions and interruption clears pending manager approvals", async () => {
  const asked = signal(); const cancelled = signal(); const decisions: PermissionResult[] = [];
  const fake = sdk(async function* (_input, options) {
    const pending = options.canUseTool!("Bash", { command: "ls" }, { signal: new AbortController().signal, suggestions: [] } as Parameters<NonNullable<Options["canUseTool"]>>[2]);
    asked.resolve(); decisions.push(await pending);
    await cancelled.promise; yield result;
  });
  fake.onInterrupt(cancelled.resolve);
  const session = new ClaudeSession("on-request", undefined, store(), fake);
  const manager = new SessionManager(undefined, () => session);
  const { threadId } = await manager.createThread({ provider: "claude", cwd: "/project" });
  await manager.submitTurn(threadId, { input: [toTextUserInput("run ls")] }); await asked.promise;
  const approval = manager.listApprovals(threadId)[0]!;
  await manager.applyApprovalDecision(threadId, approval.approvalId, { decision: approval.choices.find(choice => choice.intent === "allow")!.value });
  expect(manager.listApprovals(threadId)[0]!.status).toBe("applied");
  await manager.interruptTurn(threadId); await done(session);
  expect(decisions).toEqual([{ behavior: "allow", updatedInput: { command: "ls" } }]);
  expect(fake.interruptions()).toBe(1);
  expect((await session.listThreadTurns(threadId, {})).data[0]!.status).toBe("interrupted");
  manager.stopAll();
});

test("ending a turn expires unanswered approvals", async () => {
  const asked = signal();
  const fake = sdk(async function* (_input, options) {
    const pending = options.canUseTool!("Write", {}, { signal: new AbortController().signal } as Parameters<NonNullable<Options["canUseTool"]>>[2]);
    asked.resolve(); expect((await pending).behavior).toBe("deny"); yield result;
  });
  const session = new ClaudeSession("on-request", undefined, store(), fake);
  const manager = new SessionManager(undefined, () => session);
  const { threadId } = await manager.createThread({ provider: "claude" });
  await manager.submitTurn(threadId, { input: [toTextUserInput("write")] }); await asked.promise;
  session.stop(); await done(session);
  expect(manager.getRuntimeActivity().pendingApprovalIds).toEqual([]);
  manager.stopAll();
});

test("steering adds input to the same SDK stream and rejects a stale turn", async () => {
  const received = signal(); const gate = signal(); const messages: SDKUserMessage[] = [];
  const fake = sdk(async function* (input) {
    for await (const message of input) { messages.push(message); if (messages.length === 2) break; }
    received.resolve(); await gate.promise; yield result;
  });
  const session = new ClaudeSession("on-request", undefined, store(), fake);
  await session.startThread({}); const turnId = await session.startTurn([toTextUserInput("first")]);
  await expect(session.steerTurn([toTextUserInput("stale")], "wrong")).rejects.toThrow("matching active");
  expect(await session.steerTurn([toTextUserInput("second")], turnId)).toBe(turnId);
  await received.promise; expect(messages).toHaveLength(2); gate.resolve(); await done(session); session.stop();
});

test("SDK errors and truncated streams fail the turn and release active state", async () => {
  for (const events of [[], [{ ...result, is_error: true, result: "API failed" }]]) {
    const fake = sdk(async function* () { for (const event of events) yield event as SDKMessage; });
    const session = new ClaudeSession("on-request", undefined, store(), fake);
    const created = await session.startThread({}); await session.startTurn([toTextUserInput("hello")]); await done(session);
    expect(session.activeTurnId).toBeNull();
    expect((await session.listThreadTurns(created.threadId, {})).data[0]!.status).toBe("failed");
    expect(fake.closed()).toBe(1); session.stop();
  }
});

test("Claude rejects unsupported sandbox and audio input before starting an SDK query", async () => {
  const fake = sdk(async function* () { yield result; });
  const session = new ClaudeSession("on-request", undefined, store(), fake);
  await expect(session.startThread({ sandbox: "workspace-write" })).rejects.toThrow("sandbox mode");
  await session.startThread({});
  await expect(session.startTurn([{ type: "audio", url: "https://example.test/a.wav" }])).rejects.toThrow("input type audio");
  expect(fake.calls).toHaveLength(0); expect(session.activeTurnId).toBeNull(); session.stop();
});

test("manager selects providers and routes unloaded Claude history without spawning Codex", async () => {
  const storage = store(); const fake = sdk(async function* () { yield result; });
  const providers: string[] = [];
  const manager = new SessionManager(undefined, (policy, tools, provider) => {
    providers.push(provider);
    if (provider === "claude") return new ClaudeSession(policy, tools, storage, fake);
    const codex = new CodexSession(policy, tools);
    codex.startThread = async () => ({ threadId: "codex-thread", model: "codex-model", modelProvider: "openai", reasoningEffort: null });
    return codex;
  }, () => false, { resolve: id => id.startsWith("claude-") ? "claude" : "codex", bind: () => {} }, ["codex", "claude"]);
  await manager.createThread({});
  const { threadId } = await manager.createThread({ provider: "claude", cwd: "/project" });
  expect(providers).toEqual(["codex", "claude"]);
  await expect(manager.forkThread(threadId, { provider: "codex" })).rejects.toThrow("Cannot change");
  const created = new ClaudeSession("on-request", undefined, storage, fake); const unloaded = await created.startThread({ cwd: "/saved" });
  expect(await manager.resolveThreadCwd(unloaded.threadId)).toBe("/saved");
  expect((await manager.listThreadTurns(unloaded.threadId, {})).data).toEqual([]);
  expect(providers).toEqual(["codex", "claude", "claude"]);
  const models = await manager.listModels({ provider: "claude" });
  expect(models.data[0]!.model).toBe("sonnet");
  manager.stopAll(); created.stop();
});

test("request validation preserves agent provider independently of modelProvider", () => {
  expect(validateCreateThreadRequest({ provider: "claude", modelProvider: "anthropic" })).toMatchObject({ provider: "claude", modelProvider: "anthropic" });
  expect(validateCreateThreadRequest({ provider: "third-provider" }).provider).toBe("third-provider");
});


test("Shepherd dynamic tools retain namespaces and conversation identity through Claude MCP", async () => {
  const registry = new DynamicToolRegistry(); const calls: unknown[] = [];
  registry.register({ namespace: "signals", namespaceDescription: "Signal controls", name: "callback", description: "Create callback", inputSchema: { type: "object", properties: { kind: { type: "string" } }, required: ["kind"] }, execute: async (params) => { calls.push(params); return { success: true, contentItems: [{ type: "inputText", text: "callback-created" }] }; } });
  const fake = sdk(async function* (_input, options) {
    const server = options.mcpServers!.shepherd!;
    if (!("instance" in server)) throw new Error("Missing in-process MCP server.");
    const client = new Client({ name: "test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(serverTransport); await client.connect(clientTransport);
    const tools = await client.listTools(); expect(tools.tools[0]).toMatchObject({ name: "signals__callback", inputSchema: { required: ["kind"] } });
    expect(await client.callTool({ name: "signals__callback", arguments: { kind: "ready" } })).toMatchObject({ content: [{ type: "text", text: "callback-created" }] });
    await client.close(); await server.instance.close(); yield result;
  });
  const session = new ClaudeSession("on-request", registry, store(), fake);
  const { threadId } = await session.startThread({}); const turnId = await session.startTurn([toTextUserInput("create callback")]); await done(session);
  expect(calls).toMatchObject([{ namespace: "signals", tool: "callback", threadId, turnId, arguments: { kind: "ready" } }]);
  expect((await session.listThreadTurns(threadId, {})).data[0]!.status).toBe("completed"); session.stop();
});


test("combined stored conversations stay sorted across provider pages without duplicates", async () => {
  const manager = new SessionManager(undefined, (policy, tools, provider) => {
    const session = new CodexSession(policy, tools); session.initialize = async () => {};
    const rows = (provider === "codex" ? [9, 7, 3, 1] : [10, 8, 6, 4, 2]).map((date) => ({ id: `${provider}-${date}`, updatedAt: date }));
    session.listStoredThreads = async (request) => {
      const offset = Number(request.cursor ?? 0); const limit = request.limit ?? 20;
      return { data: rows.slice(offset, offset + limit), nextCursor: offset + limit < rows.length ? String(offset + limit) : null };
    };
    return session;
  }, () => true, undefined, ["codex", "claude"]);
  try {
    let cursor: string | undefined; const ids: string[] = [];
    let pageNumber = 0;
    do {
      const page = await manager.listStoredThreads({ cursor, limit: ++pageNumber % 2 ? 3 : 2, sortKey: "updated_at", sortDirection: "desc" });
      ids.push(...page.threads.map((thread) => thread.threadId)); cursor = page.nextCursor ?? undefined;
      expect(pageNumber).toBeLessThan(10);
    } while (cursor);
    expect(ids).toEqual(["claude-10", "codex-9", "claude-8", "codex-7", "claude-6", "claude-4", "codex-3", "claude-2", "codex-1"]);
    await expect(manager.listStoredThreads({ cursor: "shepherd-providers:garbage" })).rejects.toThrow("Invalid provider");
  } finally { manager.stopAll(); }
});

test("never approval policy maps to explicit Claude permission bypass", async () => {
  const fake = sdk(async function* (_input, options) {
    expect(options).toMatchObject({ permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true });
    expect(options.canUseTool).toBeFunction(); yield result;
  });
  const session = new ClaudeSession("never", undefined, store(), fake);
  await session.startThread({ sandbox: "danger-full-access" }); await session.startTurn([toTextUserInput("hello")]); await done(session); session.stop();
});

test("fork overrides never mutate source metadata or history", async () => {
  const storage = store(); const fake = sdk(async function* () { yield result; });
  const source = new ClaudeSession("on-request", undefined, storage, fake);
  const created = await source.startThread({ cwd: "/source", model: "sonnet", baseInstructions: "source instructions" });
  const before = storage.read(created.threadId);
  const fork = new ClaudeSession("on-request", undefined, storage, fake);
  const forked = await fork.forkThread(created.threadId, { cwd: "/fork", model: "opus", baseInstructions: "fork instructions" });
  expect(storage.read(created.threadId)).toEqual(before);
  expect(storage.read(forked.threadId)).toMatchObject({ cwd: "/fork", model: "opus", instructions: "fork instructions" });
  source.stop(); fork.stop();
});

test("renaming and archiving preserve in-memory tool results during an active turn", async () => {
  const emitted = signal(); const gate = signal(); const storage = store();
  const fake = sdk(async function* () {
    yield { type: "assistant", parent_tool_use_id: null, message: { id: "tools", content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: {} }] } } as SDKMessage;
    yield { type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "fresh", is_error: false }] } } as SDKMessage;
    emitted.resolve(); await gate.promise; yield result;
  });
  const session = new ClaudeSession("on-request", undefined, storage, fake); const created = await session.startThread({});
  await session.startTurn([toTextUserInput("run")]); await emitted.promise;
  await session.setThreadName(created.threadId, "Renamed"); await session.archiveThread(created.threadId);
  gate.resolve(); await done(session);
  expect(storage.read(created.threadId)).toMatchObject({ name: "Renamed", archived: true, turns: [{ status: "completed", items: [{ type: "userMessage" }, { id: "tool-1", type: "activity", activity: { status: "completed" }, text: JSON.stringify("fresh") }] }] });
  session.stop();
});

test("Claude questions support multiple answers, invalid retries, and bypass permissions", async () => {
  const asked = signal(); let permission: PermissionResult | undefined;
  const native = { questions: [{ header: "Parts", question: "Which parts?", multiSelect: true, options: [{ label: "API", description: "Server" }, { label: "UI", description: "Browser" }] }] };
  const fake = sdk(async function* (_input, options) {
    const pending = options.canUseTool!("AskUserQuestion", native, { signal: new AbortController().signal } as Parameters<CanUseTool>[2]);
    asked.resolve(); permission = await pending; yield result;
  });
  const session = new ClaudeSession("never", undefined, store(), fake); const manager = new SessionManager(undefined, () => session);
  const { threadId } = await manager.createThread({ provider: "claude" }); await manager.submitTurn(threadId, { input: [toTextUserInput("choose")] }); await asked.promise;
  const approval = manager.listApprovals(threadId)[0]!;
  expect(approval.userInput!.questions[0]).toMatchObject({ id: "question-0", multiSelect: true });
  await expect(manager.applyApprovalDecision(threadId, approval.approvalId, { decision: approval.choices.find(choice => choice.intent === "answer")!.value, answers: {} })).rejects.toThrow("Answer every question");
  expect(manager.listApprovals(threadId)[0]!.status).toBe("pending");
  await manager.applyApprovalDecision(threadId, approval.approvalId, { decision: approval.choices.find(choice => choice.intent === "answer")!.value, answers: { "question-0": { answers: ["API", "UI"] } } }); await done(session);
  expect(permission).toEqual({ behavior: "allow", updatedInput: { ...native, answers: { "Which parts?": ["API", "UI"] } } });
  manager.stopAll();
});

test("question cancellation and native abort settle callbacks and expire stale approvals", async () => {
  for (const cancelled of [true, false]) {
    const asked = signal(); const controller = new AbortController(); let permission: PermissionResult | undefined;
    const fake = sdk(async function* (_input, options) {
      const pending = options.canUseTool!("AskUserQuestion", { questions: [{ header: "Pick", question: "Choose?", multiSelect: false, options: [{ label: "A", description: "" }] }] }, { signal: controller.signal } as Parameters<CanUseTool>[2]);
      asked.resolve(); permission = await pending; yield result;
    });
    const session = new ClaudeSession("on-request", undefined, store(), fake); const manager = new SessionManager(undefined, () => session);
    const { threadId } = await manager.createThread({ provider: "claude" }); await manager.submitTurn(threadId, { input: [toTextUserInput("choose")] }); await asked.promise;
    const approval = manager.listApprovals(threadId)[0]!;
    if (cancelled) await manager.applyApprovalDecision(threadId, approval.approvalId, { decision: approval.choices.find(choice => choice.intent === "cancel")!.value }); else controller.abort();
    await done(session); expect(permission!.behavior).toBe("deny"); expect(manager.getRuntimeActivity().pendingApprovalIds).toEqual([]);
    await expect(session.applyApprovalDecision(approval.approvalId, { decision: approval.choices.find(choice => choice.intent === "cancel")!.value })).rejects.toThrow("Unknown Claude"); manager.stopAll();
  }
});

test("capabilities reach thread state and reject unsupported controls in the application", async () => {
  const fake = sdk(async function* () { yield result; }); const session = new ClaudeSession("on-request", undefined, store(), fake);
  const manager = new SessionManager(undefined, () => session); const { threadId } = await manager.createThread({ provider: "claude" });
  expect(manager.getThreadState(threadId)).toMatchObject({ provider: "claude", capabilities: { questions: true, skills: false, compact: false, revert: false, fork: true } });
  expect((await manager.listLoadedThreads({})).threadIds).toContain(threadId);
  await expect(manager.compactThread(threadId)).rejects.toThrow("does not support compact");
  await expect(manager.listSkills(threadId, {})).rejects.toThrow("does not support skills"); manager.stopAll();
});

test("background tasks retain the SDK stream, prevent restart, and record later wake turns", async () => {
  const { InputQueue } = await import("../server/providers/claude/input_queue.js");
  const events = new InputQueue<SDKMessage>();
  const fake = sdk(async function* () { for await (const event of events) yield event; });
  const storage = store(); const session = new ClaudeSession("on-request", undefined, storage, fake);
  const manager = new SessionManager(undefined, () => session); const { threadId } = await manager.createThread({ provider: "claude" });
  function waitFor(type: string) { return new Promise<void>(resolve => { const off = session.eventBus.subscribe(event => { if (event.type === type) { off(); resolve(); } }, { replay: false }); }); }
  await manager.submitTurn(threadId, { input: [toTextUserInput("background work")] });
  const first = done(session);
  events.push({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "task-1", ambient: false }] } as SDKMessage);
  events.push(result); await first;
  expect(session.activeTurnId).toBeNull(); expect(fake.closed()).toBe(0);
  expect(manager.getRuntimeActivity().activeTurnThreadIds).toEqual([threadId]);
  await expect(session.startTurn([toTextUserInput("change")], undefined, "opus")).rejects.toThrow("Wait for background tasks");
  expect(fake.calls).toHaveLength(1);
  const started = waitFor("turn.started"); const completed = waitFor("turn.completed");
  events.push({ type: "assistant", parent_tool_use_id: null, message: { id: "wake-message", content: [{ type: "text", text: "Background result" }] } } as SDKMessage);
  await started; events.push(result); await completed;
  expect(storage.read(threadId).turns).toHaveLength(2);
  expect(storage.read(threadId).turns[1]!.items).toMatchObject([{ type: "agentMessage", text: "Background result" }]);
  const cleared = waitFor("thread.status.changed");
  events.push({ type: "system", subtype: "background_tasks_changed", tasks: [] } as SDKMessage); await cleared;
  expect(manager.getRuntimeActivity().activeTurnThreadIds).toEqual([]);
  await manager.submitTurn(threadId, { input: [toTextUserInput("continue")] });
  const third = done(session); events.push(result); await third;
  expect(fake.calls).toHaveLength(1); expect(storage.read(threadId).turns).toHaveLength(3);
  manager.stopAll(); events.close();
});

test("shutdown persists an interrupted turn before the SDK iterator finishes", async () => {
  const gate = signal(); const storage = store();
  const fake = sdk(async function* () { await gate.promise; yield result; });
  const session = new ClaudeSession("on-request", undefined, storage, fake); const { threadId } = await session.startThread({});
  await session.startTurn([toTextUserInput("wait")]); session.stop();
  expect(storage.read(threadId).turns[0]).toMatchObject({ status: "interrupted" });
  expect(storage.read(threadId).turns[0]!.completedAt).toBeNumber();
  expect(session.activeTurnId).toBeNull(); gate.resolve();
});

test("stopping a catalog-only session closes its pending native discovery query", async () => {
  const created = signal(); const fake = sdk(async function* () { yield result; });
  const query = fake.query;
  fake.query = ((parameters: Parameters<typeof query>[0]) => {
    const running = query(parameters); const close = running.close.bind(running);
    let reject!: (error: Error) => void;
    const models = new Promise<never>((_resolve, fail) => { reject = fail; });
    running.supportedModels = () => models;
    running.close = () => { close(); reject(new Error("Discovery closed.")); };
    created.resolve(); return running;
  }) as typeof query;
  const session = new ClaudeSession("on-request", undefined, store(), fake);
  const pending = session.listModels({}); await created.promise; session.stop();
  await expect(pending).rejects.toThrow("Discovery closed"); expect(fake.closed()).toBe(1);
  await expect(session.listModels({})).rejects.toThrow("Session is stopped");
});

test("loaded conversations include every provider and respect page size", async () => {
  const storage = store(); const fake = sdk(async function* () { yield result; });
  const manager = new SessionManager(undefined, (policy, tools, provider) => {
    if (provider === "claude") return new ClaudeSession(policy, tools, storage, fake);
    const session = new CodexSession(policy, tools); session.initialize = async () => {};
    session.startThread = async () => ({ threadId: "opaque-codex-id", model: "codex", modelProvider: "openai", reasoningEffort: null });
    session.listLoadedThreads = async () => ({ data: ["opaque-codex-id"], nextCursor: null }); return session;
  });
  const codex = await manager.createThread({}); const claude = await manager.createThread({ provider: "claude" });
  const first = await manager.listLoadedThreads({ limit: 1 }); const second = await manager.listLoadedThreads({ limit: 1, cursor: first.nextCursor! });
  expect(first.threadIds).toHaveLength(1); expect(second.threadIds).toHaveLength(1); expect(second.nextCursor).toBeNull();
  expect([...first.threadIds, ...second.threadIds].sort()).toEqual([codex.threadId, claude.threadId].sort()); manager.stopAll();
});

test("background questions create a pending wake turn before an assistant message arrives", async () => {
  const asked = signal(); const gate = signal();
  const fake = sdk(async function* (_input, options) {
    yield result; await gate.promise;
    const pending = options.canUseTool!("AskUserQuestion", { questions: [{ header: "Continue", question: "Continue work?", multiSelect: false, options: [{ label: "Yes", description: "" }] }] }, { signal: new AbortController().signal } as Parameters<CanUseTool>[2]);
    asked.resolve(); expect((await pending).behavior).toBe("allow"); yield result;
  });
  const session = new ClaudeSession("on-request", undefined, store(), fake); const manager = new SessionManager(undefined, () => session);
  const { threadId } = await manager.createThread({ provider: "claude" }); await manager.submitTurn(threadId, { input: [toTextUserInput("start")] }); await done(session);
  gate.resolve(); await asked.promise;
  const request = manager.listApprovals(threadId).find(approval => approval.status === "pending")!;
  expect(request.userInput!.turnId).toBe(session.activeTurnId);
  await expect(Promise.resolve().then(() => session.setCwd("/different"))).rejects.toThrow("Wait for Claude work");
  await manager.applyApprovalDecision(threadId, request.approvalId, { decision: request.choices.find(choice => choice.intent === "answer")!.value, answers: { "question-0": { answers: ["Yes"] } } }); await done(session);
  expect((await session.listThreadTurns(threadId, {})).data).toHaveLength(2); manager.stopAll();
});

test("Claude streams forward allowance events to the account observer without conversation telemetry", async () => {
  const info = { status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.8 } as const;
  const identity = { subscriptionType: "pro", apiProvider: "firstParty" };
  const observations: unknown[] = [];
  const fake = sdk(async function* () {
    yield { type: "rate_limit_event", rate_limit_info: info } as SDKMessage;
    yield result;
  });
  const open = fake.query;
  fake.query = (options => Object.assign(open(options), { accountInfo: async () => identity })) as typeof query;
  const session = new ClaudeSession("on-request", undefined, store(), fake, {
    scope: () => "credential-scope", observe: (...values) => { observations.push(values); },
  });
  try {
    await session.startThread({ cwd: "/project" });
    const events: BridgeEvent[] = [];
    session.eventBus.subscribe(event => events.push(event), { replay: false });
    await session.startTurn([toTextUserInput("hello")]); await done(session);
    expect(observations).toEqual([[info, identity, "credential-scope"]]);
    expect(events.some(event => event.type === "turn.failed")).toBe(false);
    expect(events.filter(event => event.type.includes("rateLimit"))).toEqual([]);
  } finally { session.stop(); }
});

test("an unavailable account lookup cannot stall a Claude response", async () => {
  const fake = sdk(async function* () {
    yield { type: "rate_limit_event", rate_limit_info: { status: "allowed" } } as SDKMessage;
    yield result;
  });
  const open = fake.query;
  fake.query = (options => Object.assign(open(options), { accountInfo: () => new Promise(() => {}) })) as typeof query;
  const session = new ClaudeSession("on-request", undefined, store(), fake, { scope: () => "scope", observe() { throw new Error("Must not observe an unknown account"); } });
  try {
    await session.startThread({ cwd: "/project" });
    await session.startTurn([toTextUserInput("hello")]); await done(session);
    expect(session.activeTurnId).toBeNull();
  } finally { session.stop(); }
});

test("new Claude defaults reach SDK turns and saved conversations retain explicit settings", async () => {
  const previousModel = process.env.CLAUDE_MODEL; const previousEffort = process.env.CLAUDE_EFFORT;
  delete process.env.CLAUDE_MODEL; delete process.env.CLAUDE_EFFORT;
  const storage = store();
  const fake = sdk(async function* () { yield result; });
  const session = new ClaudeSession("on-request", undefined, storage, fake);
  const resumed = new ClaudeSession("on-request", undefined, storage, fake);
  const forked = new ClaudeSession("on-request", undefined, storage, fake);
  try {
    const created = await session.startThread({ cwd: "/project" });
    expect(created).toMatchObject({ model: "claude-opus-5-5", reasoningEffort: "medium" });
    await session.startTurn([toTextUserInput("hello")]); await done(session);
    expect(fake.calls[0]!.options).toMatchObject({ model: "claude-opus-5-5", effort: "medium" });
    const saved = storage.read(created.threadId); saved.model = "sonnet"; saved.effort = "high"; saved.materialized = false; storage.write(saved);
    process.env.CLAUDE_MODEL = "haiku"; process.env.CLAUDE_EFFORT = "low";
    expect(await resumed.resumeThread(created.threadId, {})).toMatchObject({ model: "sonnet", reasoningEffort: "high" });
    expect(await forked.forkThread(created.threadId, {})).toMatchObject({ model: "sonnet", reasoningEffort: "high" });
    const explicit = new ClaudeSession("on-request", undefined, storage, fake);
    expect(await explicit.startThread({ model: "opus" })).toMatchObject({ model: "opus", reasoningEffort: "low" });
    explicit.stop();
  } finally {
    session.stop(); resumed.stop(); forked.stop();
    if (previousModel === undefined) delete process.env.CLAUDE_MODEL; else process.env.CLAUDE_MODEL = previousModel;
    if (previousEffort === undefined) delete process.env.CLAUDE_EFFORT; else process.env.CLAUDE_EFFORT = previousEffort;
  }
});

test("Claude effort controls find pinned default IDs and legacy aliases through the shared manager", async () => {
  const fake = sdk(async function* () { yield result; });
  const open = fake.query;
  fake.query = (options => Object.assign(open(options), { supportedModels: async () => [
    { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "Opus", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high"] },
  ] })) as typeof query;
  const storage = store();
  const manager = new SessionManager(undefined, (policy, tools) => new ClaudeSession(policy, tools, storage, fake));
  try {
    const { threadId } = await manager.createThread({ provider: "claude", model: "claude-opus-5-5" });
    expect(await manager.getThreadEffort(threadId)).toMatchObject({ model: "claude-opus-5-5", currentEffort: "medium", defaultEffort: "medium" });
    expect(await manager.setThreadEffort(threadId, "default")).toMatchObject({ pendingEffort: "medium" });
    const legacy = await manager.createThread({ provider: "claude", model: "opus" });
    expect(await manager.getThreadEffort(legacy.threadId)).toMatchObject({ model: "opus", currentEffort: "medium" });
    expect((await manager.listModels({ provider: "claude" })).data.map(row => row.model)).toEqual(["claude-opus-5-5"]);
  } finally { manager.stopAll(); }
});

test("per-block assistant messages mark text before tools as commentary and the last text as the answer", async () => {
  const stream = (event: unknown) => ({ type: "stream_event", parent_tool_use_id: null, event }) as SDKMessage;
  const assistant = (id: string, block: unknown) => ({ type: "assistant", parent_tool_use_id: null, message: { id, content: [block] } }) as SDKMessage;
  const fake = sdk(async function* () {
    yield stream({ type: "message_start", message: { id: "plan", usage: {} } });
    yield stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    yield stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Checking tests." } });
    yield assistant("plan", { type: "text", text: "Checking tests." });
    yield assistant("plan", { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "bun test" } });
    yield { type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok", is_error: false }] } } as SDKMessage;
    yield stream({ type: "message_start", message: { id: "answer", usage: {} } });
    yield stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    yield stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Tests pass." } });
    yield stream({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
    yield stream({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Nothing else to do." } });
    yield assistant("answer", { type: "text", text: "Tests pass." });
    yield assistant("answer", { type: "text", text: "Nothing else to do." });
    yield result;
  });
  const session = new ClaudeSession("on-request", undefined, store(), fake);
  const { threadId } = await session.startThread({});
  const events: BridgeEvent[] = []; session.eventBus.subscribe(event => events.push(event), { replay: false });
  await session.startTurn([toTextUserInput("run tests")]); await done(session);
  expect(events.filter(event => event.type === "turn.stream.delta").map(event => (event.payload as { itemId: string }).itemId)).toEqual(["plan", "answer", "answer:1"]);
  expect(events.filter(event => event.type === "turn.message.completed").map(event => event.payload)).toMatchObject([
    { itemId: "plan", phase: "commentary" }, { itemId: "answer", phase: "final_answer" }, { itemId: "answer:1", phase: "final_answer" },
  ]);
  expect((await session.listThreadTurns(threadId, {})).data[0]!.items.map(item => [item.id, item.phase ?? null])).toEqual([
    [expect.any(String), null], ["plan", "commentary"], ["tool-1", null], ["answer", "final_answer"], ["answer:1", "final_answer"],
  ]);
  const chat = events.reduce(reduceBridge, emptyChat());
  expect(timelineGroups(chat).flatMap(group => group.finalIds)).toEqual(["answer", "answer:1"]);
  session.stop();
});

test("token usage reports the last request's context and the model context window", async () => {
  const stream = (event: unknown) => ({ type: "stream_event", parent_tool_use_id: null, event }) as SDKMessage;
  const fake = sdk(async function* () {
    yield stream({ type: "message_start", message: { id: "m", usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 5, output_tokens: 1 } } });
    yield stream({ type: "message_delta", delta: {}, usage: { output_tokens: 50 } });
    yield { type: "assistant", parent_tool_use_id: null, message: { id: "m", content: [{ type: "text", text: "Done" }] } } as SDKMessage;
    yield { ...result, usage: { input_tokens: 9_999, cache_read_input_tokens: 99_999, output_tokens: 999 },
      modelUsage: { "claude-opus-5-5": { inputTokens: 10, outputTokens: 50, cacheReadInputTokens: 1000, cacheCreationInputTokens: 5, contextWindow: 200_000 } } } as SDKMessage;
  });
  const session = new ClaudeSession("on-request", undefined, store(), fake);
  await session.startThread({ model: "claude-opus-5-5" });
  const updates: unknown[] = []; session.eventBus.subscribe(event => { if (event.type === "thread.tokenUsage.updated") updates.push(event.payload); }, { replay: false });
  await session.startTurn([toTextUserInput("hello")]); await done(session);
  expect(updates).toMatchObject([{ tokenUsage: { last: { inputTokens: 1015, cachedInputTokens: 1000, outputTokens: 50, totalTokens: 1065 }, modelContextWindow: 200_000 } }]);
  session.stop();
});

test("forking a materialized thread searches every project directory for its transcript", async () => {
  const storage = store(); const fake = sdk(async function* () { yield result; });
  const source = new ClaudeSession("on-request", undefined, storage, fake);
  const created = await source.startThread({ cwd: "/workspace-a" });
  const saved = storage.read(created.threadId); saved.materialized = true; saved.cwd = "/workspace-b"; storage.write(saved);
  const fork = new ClaudeSession("on-request", undefined, storage, fake);
  const forked = await fork.forkThread(created.threadId, {});
  expect(fake.forks).toEqual([[created.threadId.slice(7)]]);
  fork.setCwd("/workspace-c"); await fork.startTurn([toTextUserInput("continue")]); await done(fork);
  expect(fake.calls[0]!.options).toMatchObject({ cwd: "/workspace-c", resume: forked.threadId.slice(7) });
  source.stop(); fork.stop();
});

test("streamed blocks coalesce history writes and stored tool output is bounded", async () => {
  const storage = store(); let writes = 0;
  const write = storage.write.bind(storage); storage.write = thread => { writes++; write(thread); };
  const fake = sdk(async function* () {
    for (let index = 0; index < 20; index++) {
      yield { type: "assistant", parent_tool_use_id: null, message: { id: `m${index}`, content: [{ type: "tool_use", id: `tool-${index}`, name: "Read", input: {} }] } } as SDKMessage;
      yield { type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: `tool-${index}`, content: index ? "x".repeat(20_000) : [{ type: "image", source: { type: "base64", data: "AAAA" } }, { type: "text", text: "caption" }], is_error: false }] } } as SDKMessage;
    }
    yield result;
  });
  const session = new ClaudeSession("on-request", undefined, storage, fake);
  const { threadId } = await session.startThread({}); writes = 0;
  await session.startTurn([toTextUserInput("read")]); await done(session);
  expect(writes).toBeLessThanOrEqual(3);
  const items = storage.read(threadId).turns[0]!.items;
  expect(JSON.parse(items[1]!.text!)).toEqual([{ type: "image", omitted: true }, { type: "text", text: "caption" }]);
  expect(String(items[2]!.text).length).toBeLessThan(8_100);
  session.stop();
});

test("the model catalog is cached and concurrent lookups share one CLI process", async () => {
  const fake = sdk(async function* () { yield result; });
  const session = new ClaudeSession("on-request", undefined, store(), fake);
  await Promise.all([session.listModels({}), session.listModels({})]);
  await session.listModels({ includeHidden: true });
  expect(fake.calls).toHaveLength(1);
  session.stop();
});

test("newly registered Shepherd tools reopen the idle SDK process before the next turn", async () => {
  const registry = new DynamicToolRegistry();
  const fake = sdk(async function* (input) { for await (const _message of input) yield result; });
  const session = new ClaudeSession("on-request", registry, store(), fake);
  await session.startThread({});
  await session.startTurn([toTextUserInput("one")]); await done(session);
  await session.startTurn([toTextUserInput("two")]); await done(session);
  expect(fake.calls).toHaveLength(1);
  registry.register({ namespace: "late", namespaceDescription: "Late tools", name: "late", description: "Late tool", inputSchema: { type: "object" }, execute: async () => ({ success: true, contentItems: [] }) });
  await session.startTurn([toTextUserInput("three")]); await done(session);
  expect(fake.calls).toHaveLength(2); expect(fake.closed()).toBe(1);
  expect(Object.keys(fake.calls[1]!.options.mcpServers!)).toEqual(["shepherd"]);
  session.stop();
});

test("thread listing reads summaries, rebuilds legacy summaries, and skips unreadable snapshots", async () => {
  const { writeFileSync, rmSync: remove, existsSync } = await import("node:fs");
  const directory = mkdtempSync(join(tmpdir(), "shepherd-claude-test-")); directories.push(directory);
  const warnings: string[] = []; const storage = new ClaudeThreadStore(directory, message => warnings.push(message));
  expect(storage.hasThreads()).toBe(false);
  const session = new ClaudeSession("on-request", undefined, storage, sdk(async function* () { yield result; }));
  const { threadId } = await session.startThread({ cwd: "/project" }); session.stop();
  remove(join(directory, `${threadId}.meta.json`));
  writeFileSync(join(directory, "claude-00000000-0000-0000-0000-000000000000.json"), "{");
  const rows = storage.list();
  expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ id: threadId, cwd: "/project" }); expect("turns" in rows[0]!).toBe(false);
  expect(existsSync(join(directory, `${threadId}.meta.json`))).toBe(true);
  expect(warnings).toHaveLength(1); expect(storage.hasThreads()).toBe(true);
});

test("Claude applies opaque permission options through the shared session boundary", async () => {
  const asked = signal(), decisions: PermissionResult[] = [];
  const fake = sdk(async function* (_input, options) {
    const pending = options.canUseTool!("Read", { file_path: "/project/readme.md" }, { signal: new AbortController().signal, suggestions: [] } as Parameters<CanUseTool>[2]);
    asked.resolve(); decisions.push(await pending); yield result;
  });
  const session = new ClaudeSession("on-request", undefined, store(), fake), manager = new SessionManager(undefined, () => session);
  const { threadId } = await manager.createThread({ provider: "claude", cwd: "/project" });
  const observed: BridgeEvent[] = [];
  manager.subscribeToThreadEvents(threadId, event => observed.push(event));
  await manager.submitTurn(threadId, { input: [toTextUserInput("read")] }); await asked.promise;
  const pending = manager.listApprovals(threadId)[0]!;
  expect(pending.kind).toBe("permission"); expect(pending.detail).toContain("/project/readme.md");
  expect(pending.choices.map(choice => choice.intent)).toEqual(["allow", "deny"]);
  expect(pending.choices.some(choice => ["accept", "decline"].includes(choice.value))).toBe(false);
  await manager.applyApprovalDecision(threadId, pending.approvalId, { decision: pending.choices.find(choice => choice.intent === "allow")!.value });
  await done(session);
  expect(decisions).toEqual([{ behavior: "allow", updatedInput: { file_path: "/project/readme.md" } }]);
  expect(manager.listApprovals(threadId).every(record => record.status !== "pending")).toBe(true);
  await expect(manager.applyApprovalDecision(threadId, pending.approvalId, { decision: pending.choices[0]!.value })).rejects.toThrow("already");
  manager.stopAll();
});
