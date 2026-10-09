import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { query, Query, SDKMessage, SDKUserMessage, PermissionResult, Options } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSession, ClaudeThreadStore } from "../server/core/claude_session.js";
import { SessionManager } from "../server/core/session_manager.js";
import { CodexSession } from "../server/core/codex_session.js";
import { DynamicToolRegistry } from "../server/core/dynamic_tool_registry.js";
import { toTextUserInput } from "../shared/protocol/user_input.js";
import type { BridgeEvent } from "../shared/protocol/events.js";
import { validateCreateThreadRequest } from "../shared/protocol/validation.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { reduceBridge, emptyChat } from "../ui/src/chat-state.js";

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
  return { query: queryFn, forkSession: async () => ({ sessionId: "12345678-1234-1234-1234-123456789abc" }), calls, closed: () => closed, interruptions: () => interruptions, onInterrupt: (fn: () => void) => { interrupt = fn; } };
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
  expect(events.map((e) => e.type)).toEqual(["turn.started", "turn.stream.delta", "turn.message.completed", "thread.tokenUsage.updated", "turn.completed"]);
  const chat = events.reduce(reduceBridge, emptyChat());
  expect(chat.messages.filter((message) => message.role === "assistant")).toMatchObject([{ text: "Hello", complete: true }]);
  expect(events[1]!.payload).toMatchObject({ method: "item/agentMessage/delta", itemId: "msg-1", textDelta: "Hello", turnId });
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
  await manager.applyApprovalDecision(threadId, approval.approvalId, { decision: "accept" });
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
  });
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
  expect(() => validateCreateThreadRequest({ provider: "unknown" })).toThrow("provider");
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
  }, () => true);
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
    expect(options.canUseTool).toBeUndefined(); yield result;
  });
  const session = new ClaudeSession("never", undefined, store(), fake);
  await session.startThread({ sandbox: "danger-full-access" }); await session.startTurn([toTextUserInput("hello")]); await done(session); session.stop();
});
