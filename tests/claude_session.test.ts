import { ClaudeModelCache } from "../server/providers/claude/model_cache.js";
import { sessionProviders } from "./helpers/session_providers.js";
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { query, Query, SDKMessage, SDKSessionInfo, SDKUserMessage, PermissionResult, Options, CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeNative } from "../server/providers/claude/native_sessions.js";
import { decodeTranscript, type TranscriptEntry } from "../server/providers/claude/transcript.js";
import { ClaudeSession } from "../server/providers/claude/session.js";
import { POLICY_PRESETS } from "../shared/protocol/execution_policy.js";
import { ClaudeProvider } from "../server/providers/claude/provider.js";
import { noProviderTools } from "../server/ports/provider_tools.js";
import { SessionManager } from "../server/core/session_manager.js";
import { CodexSession } from "../server/providers/codex/session.js";
import { DynamicToolRegistry } from "../server/core/dynamic_tool_registry.js";
import { toTextUserInput } from "../shared/protocol/user_input.js";
import type { BridgeEvent } from "../shared/protocol/events.js";
import type { HistoryItem } from "../shared/protocol/requests.js";
import { validateCreateThreadRequest } from "../shared/protocol/validation.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { reduceBridge, emptyChat } from "../ui/src/chat-state.js";
import { timelineGroups } from "../ui/src/timeline.js";

function signal() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
const result = { type: "result", subtype: "success", is_error: false, result: "Hello", usage: { input_tokens: 4, output_tokens: 3 }, modelUsage: { sonnet: { inputTokens: 4, outputTokens: 3, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } } as SDKMessage;
type Entry = TranscriptEntry & { session_id: string };
/** A fake Claude SDK whose sessions record what each query reads and streams, as Claude Code
 * writes its transcript. Prompts are read as they are pushed, whether or not a script reads them. */
function sdk(script: (input: AsyncIterable<SDKUserMessage>, options: Options) => AsyncGenerator<SDKMessage>) {
  const calls: Array<{ options: Options; input: AsyncIterable<SDKUserMessage> }> = [];
  const sessions = new Map<string, { info: SDKSessionInfo; entries: Entry[] }>();
  // Claude Code stores each subagent's transcript apart from its session's.
  const subagents = new Map<string, Map<string, Entry[]>>();
  let closed = 0;
  let interruptions = 0;
  let interrupt = () => {};
  let clock = Date.parse("2026-01-01T00:00:00Z");
  const record = (sessionId: string, cwd: string | undefined, entry: Omit<Entry, "session_id" | "timestamp">) => {
    const session = sessions.get(sessionId) ?? { info: { sessionId, summary: "", lastModified: clock, createdAt: clock, ...(cwd ? { cwd } : {}) }, entries: [] };
    sessions.set(sessionId, session);
    clock += 1000;
    session.entries.push({ ...entry, session_id: sessionId, timestamp: new Date(clock).toISOString() });
    session.info.lastModified = clock;
    const text = entry.type === "user" ? (entry.message as { content: Array<{ type: string; text?: string }> }).content.find(block => block.type === "text")?.text : undefined;
    if (text && !session.info.firstPrompt) session.info = { ...session.info, firstPrompt: text, summary: text };
  };
  const queryFn = (({ prompt, options }: Parameters<typeof query>[0]) => {
    const sessionId = options!.resume ?? options!.sessionId!;
    let busy = false;
    const buffered: SDKUserMessage[] = []; let wake: (() => void) | null = null; let ended = false;
    void (async () => {
      for await (const message of prompt as AsyncIterable<SDKUserMessage>) {
        record(sessionId, options!.cwd, { type: "user", uuid: message.uuid!, message: message.message, parent_tool_use_id: null, ...(busy ? { isQueuedCommand: true } : {}) });
        busy = true; buffered.push(message); wake?.();
      }
      ended = true; wake?.();
    })();
    const input: AsyncIterable<SDKUserMessage> = { async *[Symbol.asyncIterator]() {
      while (true) {
        if (buffered.length) { yield buffered.shift()!; continue; }
        if (ended) return;
        await new Promise<void>(resolve => { wake = resolve; }); wake = null;
      }
    } };
    calls.push({ options: options!, input });
    const output = (async function* () {
      for await (const message of script(input, options!)) {
        if ((message.type === "assistant" || (message.type === "user" && Array.isArray(message.message.content))) && !message.parent_tool_use_id) {
          record(sessionId, options!.cwd, { type: message.type, uuid: randomUUID(), message: message.message, parent_tool_use_id: null });
        }
        const agentId = (message as { agent_id?: string }).agent_id;
        if ((message.type === "assistant" || message.type === "user") && message.parent_tool_use_id && agentId) {
          const agents = subagents.get(sessionId) ?? new Map<string, Entry[]>(); subagents.set(sessionId, agents);
          clock += 1000;
          agents.set(agentId, [...agents.get(agentId) ?? [], { type: message.type, uuid: randomUUID(), message: message.message, parent_tool_use_id: message.parent_tool_use_id, session_id: sessionId, timestamp: new Date(clock).toISOString() }]);
        }
        if (message.type === "result") busy = false;
        yield message;
      }
    })();
    return Object.assign(output, { close: () => { closed++; }, interrupt: async () => { interruptions++; interrupt(); }, supportedModels: async () => [{ value: "sonnet", displayName: "Sonnet", description: "Claude", supportsEffort: true, supportedEffortLevels: ["low", "high"] }, { value: "claude-opus-5-5", displayName: "Opus", description: "Default", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high"] }] }) as unknown as Query;
  }) as typeof query;
  const forks: unknown[][] = [];
  const native = {
    query: queryFn,
    forkSession: async (id: string, ...rest: unknown[]) => {
      forks.push([id, ...rest]);
      const forked = "12345678-1234-1234-1234-123456789abc", source = sessions.get(id);
      // Forks copy the transcript with new entry IDs.
      if (source) sessions.set(forked, { info: { ...source.info, sessionId: forked, customTitle: undefined, tag: undefined }, entries: source.entries.map(entry => ({ ...entry, uuid: randomUUID(), session_id: forked })) });
      return { sessionId: forked };
    },
    listSessions: async () => [...sessions.values()].map(session => session.info),
    getSessionInfo: async (id: string) => sessions.get(id)?.info,
    getSessionMessages: async (id: string) => sessions.get(id)?.entries ?? [],
    listSubagents: async (id: string) => [...subagents.get(id)?.keys() ?? []],
    getSubagentMessages: async (id: string, agentId: string) => subagents.get(id)?.get(agentId) ?? [],
    renameSession: async (id: string, title: string) => { sessions.get(id)!.info.customTitle = title; },
    tagSession: async (id: string, tag: string | null) => { sessions.get(id)!.info.tag = tag ?? undefined; },
  } as unknown as ClaudeNative;
  return Object.assign(native, { forks, calls, sessions, closed: () => closed, interruptions: () => interruptions, onInterrupt: (fn: () => void) => { interrupt = fn; } });
}
async function done(session: ClaudeSession) {
  if (!session.activeTurnId) return;
  await new Promise<void>((resolve) => {
    const unsub = session.eventBus.subscribe((event) => { if (event.type === "turn.completed" || event.type === "turn.failed") { unsub(); resolve(); } }, { replay: false });
  });
}

test("Claude streams common events and resumes the native session from its transcript", async () => {
  const fake = sdk(async function* (input, options) {
    for await (const message of input) { expect(message.message.role).toBe("user"); break; }
    yield { type: "system", subtype: "init", session_id: options.resume ?? options.sessionId } as SDKMessage;
    yield { type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id: "msg-1" } } } as SDKMessage;
    yield { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } } } as SDKMessage;
    yield { type: "assistant", parent_tool_use_id: null, message: { id: "msg-1", content: [{ type: "text", text: "Hello" }] } } as SDKMessage;
    yield result;
  });
  const session = new ClaudeSession(undefined, fake);
  const created = await session.startThread({ cwd: "/old" });
  session.setCwd("/project");
  const events: BridgeEvent[] = []; session.eventBus.subscribe((event) => events.push(event), { replay: false });
  const turnId = await session.startTurn([toTextUserInput("hello")]); await done(session);
  expect(fake.calls[0]!.options.env).toBeDefined();
  if (process.env.CLAUDE_AUTH_MODE !== "api") {
    expect(fake.calls[0]!.options.env!.ANTHROPIC_API_KEY).toBe("");
    expect(fake.calls[0]!.options.settings).toMatchObject({ forceLoginMethod: "claudeai", apiKeyHelper: "" });
  }
  expect(events.map((e) => e.type)).toEqual(["thread.settings.changed", "turn.started", "item.delta", "item.completed", "thread.tokenUsage.updated", "turn.completed"]);
  expect(events[0]!.payload).toEqual({ model: "claude-opus-5-5", effort: "medium", cwd: "/project", profile: null });
  const chat = events.reduce(reduceBridge, emptyChat());
  expect(chat.messages.filter((message) => message.role === "assistant")).toMatchObject([{ text: "Hello", complete: true }]);
  expect(events[2]!.payload).toEqual({ channel: "message", phase: null, itemId: "msg-1", delta: "Hello", turnId });
  expect((await session.listThreadTurns(created.threadId, {})).data[0]).toMatchObject({ status: "completed", items: [{ type: "user_message" }, { type: "assistant_message", text: "Hello" }] });
  const resumed = new ClaudeSession(undefined, fake);
  await resumed.resumeThread(created.threadId, {});
  await resumed.startTurn([toTextUserInput("again")]); await done(resumed);
  // The conversation is Claude's session: same ID, resumed in the workspace Claude recorded.
  expect(fake.calls[1]!.options).toMatchObject({ cwd: "/project", resume: created.threadId });
  expect((await resumed.listThreadTurns(created.threadId, { limit: 1 })).nextCursor).toBe("1");
  await resumed.archiveThread(created.threadId);
  expect((await new ClaudeProvider(fake).listStoredThreads({ archived: true })).data).toHaveLength(1);
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
  const session = new ClaudeSession(undefined, fake);
  const manager = new SessionManager(undefined, sessionProviders(() => session));
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
  const session = new ClaudeSession(undefined, fake);
  const manager = new SessionManager(undefined, sessionProviders(() => session));
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
  const session = new ClaudeSession(undefined, fake);
  await session.startThread({}); const turnId = await session.startTurn([toTextUserInput("first")]);
  await expect(session.steerTurn([toTextUserInput("stale")], "wrong")).rejects.toThrow("matching active");
  expect(await session.steerTurn([toTextUserInput("second")], turnId)).toBe(turnId);
  await received.promise; expect(messages).toHaveLength(2); gate.resolve(); await done(session); session.stop();
});

test("SDK errors and truncated streams fail the turn and release active state", async () => {
  for (const events of [[], [{ ...result, is_error: true, result: "API failed" }]]) {
    const fake = sdk(async function* () { for (const event of events) yield event as SDKMessage; });
    const session = new ClaudeSession(undefined, fake);
    const created = await session.startThread({}); await session.startTurn([toTextUserInput("hello")]); await done(session);
    expect(session.activeTurnId).toBeNull();
    expect((await session.listThreadTurns(created.threadId, {})).data[0]!.status).toBe("failed");
    expect(fake.closed()).toBe(1); session.stop();
  }
});

test("Claude rejects unknown policy profiles and audio input before starting an SDK query", async () => {
  const fake = sdk(async function* () { yield result; });
  const session = new ClaudeSession(undefined, fake);
  await expect(session.startThread({ profile: "danger-full-access:never" })).rejects.toThrow("Unknown Claude policy profile");
  await session.startThread({});
  await expect(session.startTurn([{ type: "audio", url: "https://example.test/a.wav" }])).rejects.toThrow("audio inputs");
  expect(fake.calls).toHaveLength(0); expect(session.activeTurnId).toBeNull(); session.stop();
});

test("manager selects providers and routes unloaded Claude history without spawning Codex", async () => {
  const fake = sdk(async function* (_input, options) { yield { type: "system", subtype: "init", session_id: options.resume ?? options.sessionId } as SDKMessage; yield result; });
  const providers: string[] = [];
  const manager = new SessionManager(undefined, sessionProviders((tools, provider) => {
    providers.push(provider);
    if (provider === "claude") return new ClaudeSession(tools, fake);
    const codex = new CodexSession(tools);
    codex.startThread = async () => ({ threadId: "codex-thread", cwd: "/tmp", model: "codex-model", effort: null, profile: null });
    return codex;
  }), () => false, { resolve: id => id === "codex-thread" ? "codex" : "claude", bind: () => {} }, ["codex", "claude"]);
  await manager.createThread({});
  const { threadId } = await manager.createThread({ provider: "claude", cwd: "/project" });
  expect(providers).toEqual(["codex", "claude"]);
  await expect(manager.forkThread(threadId, { provider: "codex" })).rejects.toThrow("Cannot change");
  // A conversation another process ran exists only in Claude's sessions.
  const created = new ClaudeSession(undefined, fake); const unloaded = await created.startThread({ cwd: "/saved" });
  await created.startTurn([toTextUserInput("saved")]); await done(created); created.stop();
  expect(await manager.resolveThreadCwd(unloaded.threadId)).toBe("/saved");
  expect((await manager.listThreadTurns(unloaded.threadId, {})).data).toMatchObject([{ status: "completed", items: [{ type: "user_message", content: [{ type: "text", text: "saved" }] }] }]);
  expect(providers).toEqual(["codex", "claude", "claude"]);
  const models = await manager.listModels({ provider: "claude" });
  expect(models.data[0]!.id).toBe("sonnet");
  manager.stopAll(); created.stop();
});

test("request validation preserves opaque provider identities and rejects native backend overrides", () => {
  expect(() => validateCreateThreadRequest({ provider: "claude", modelProvider: "anthropic" })).toThrow("Unsupported request field: modelProvider");
  expect(validateCreateThreadRequest({ provider: "third-provider" }).provider).toBe("third-provider");
});


test("Shepherd dynamic tools retain namespaces and conversation identity through Claude MCP", async () => {
  const registry = new DynamicToolRegistry(); const calls: unknown[] = [];
  registry.register({ namespace: "signals", namespaceDescription: "Signal controls", name: "callback", description: "Create callback", inputSchema: { type: "object", properties: { kind: { type: "string" } }, required: ["kind"] }, execute: async (params) => { calls.push(params); return { success: true, contentItems: [{ type: "text", text: "callback-created" }] }; } });
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
  const session = new ClaudeSession(registry, fake);
  const { threadId } = await session.startThread({}); const turnId = await session.startTurn([toTextUserInput("create callback")]); await done(session);
  expect(calls).toMatchObject([{ namespace: "signals", tool: "callback", threadId, turnId, arguments: { kind: "ready" } }]);
  expect((await session.listThreadTurns(threadId, {})).data[0]!.status).toBe("completed"); session.stop();
});


test("combined stored conversations stay sorted across provider pages without duplicates", async () => {
  const manager = new SessionManager(undefined, sessionProviders((tools, provider) => {
    const session = new CodexSession(tools); session.initialize = async () => {};
    const rows = (provider === "codex" ? [9, 7, 3, 1] : [10, 8, 6, 4, 2]).map((date) => ({ id: `${provider}-${date}`, updatedAt: date }));
    session.listStoredThreads = async (request) => {
      const offset = Number(request.cursor ?? 0); const limit = request.limit ?? 20;
      return { data: rows.slice(offset, offset + limit), nextCursor: offset + limit < rows.length ? String(offset + limit) : null };
    };
    return session;
  }), () => true, undefined, ["codex", "claude"]);
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

test("the bypass policy resolves to Claude's explicit permission bypass", async () => {
  const fake = sdk(async function* () { yield result; });
  const session = new ClaudeSession(undefined, fake); const manager = new SessionManager(undefined, sessionProviders(() => session));
  const { threadId } = await manager.createThread({ provider: "claude", policy: POLICY_PRESETS.bypass });
  expect(manager.getThreadState(threadId).policy).toEqual({ profile: "bypassPermissions", policy: POLICY_PRESETS.bypass });
  await manager.submitTurn(threadId, { input: [toTextUserInput("hello")] }); await done(session);
  // Asserted on the recorded options: a failure inside the SDK script would only fail the turn.
  // Submitting reads the model catalog first, which is a separate query.
  const turn = fake.calls.find(call => call.options.sessionId || call.options.resume)!;
  expect(fake.calls.map(call => call.options.permissionMode)).toEqual(["dontAsk", "bypassPermissions"]);
  expect(turn.options).toMatchObject({ permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true });
  expect(turn.options.canUseTool).toBeFunction();
  manager.stopAll();
});

test("forks are new Claude sessions: overrides apply to the fork and never change the source", async () => {
  const fake = sdk(async function* (_input, options) { yield { type: "system", subtype: "init", session_id: options.resume ?? options.sessionId } as SDKMessage; yield result; });
  const source = new ClaudeSession(undefined, fake);
  const created = await source.startThread({ cwd: "/source", model: "sonnet" });
  await source.startTurn([toTextUserInput("first")]); await done(source);
  const before = structuredClone(fake.sessions.get(created.threadId));
  const fork = new ClaudeSession(undefined, fake);
  const forked = await fork.forkThread(created.threadId, { cwd: "/fork", model: "opus" });
  expect(fake.sessions.get(created.threadId)).toEqual(before!);
  expect(forked).toMatchObject({ threadId: "12345678-1234-1234-1234-123456789abc", cwd: "/fork", model: "opus" });
  // The fork's history is its own copy of the transcript.
  expect((await fork.listThreadTurns(forked.threadId, {})).data).toMatchObject([{ items: [{ type: "user_message", content: [{ text: "first" }] }] }]);
  source.stop(); fork.stop();
});

test("new conversations use Claude's preset prompt without additions", async () => {
  const fake = sdk(async function* () { yield result; });
  const session = new ClaudeSession(undefined, fake);
  await session.startThread({ cwd: "/project" });
  await session.startTurn([toTextUserInput("hello")]); await done(session);
  expect(fake.calls[0]!.options.systemPrompt).toEqual({ type: "preset", preset: "claude_code" });
  session.stop();
});

test("renaming and archiving go to Claude's session, including changes made before it exists", async () => {
  const fake = sdk(async function* (_input, options) { yield { type: "system", subtype: "init", session_id: options.resume ?? options.sessionId } as SDKMessage; yield result; });
  const session = new ClaudeSession(undefined, fake); const created = await session.startThread({});
  await session.setThreadName(created.threadId, "Early name"); await session.archiveThread(created.threadId);
  expect(fake.sessions.has(created.threadId)).toBe(false);
  expect(await session.readThread(created.threadId, false)).toMatchObject({ thread: { name: "Early name" } });
  await session.startTurn([toTextUserInput("run")]); await done(session);
  await Promise.resolve();
  expect(fake.sessions.get(created.threadId)!.info).toMatchObject({ customTitle: "Early name", tag: "archived" });
  await session.unarchiveThread(created.threadId); await session.setThreadName(created.threadId, "Renamed");
  expect(fake.sessions.get(created.threadId)!.info).toMatchObject({ customTitle: "Renamed" });
  expect(fake.sessions.get(created.threadId)!.info.tag).toBeUndefined();
  expect((await new ClaudeProvider(fake).listStoredThreads({})).data).toMatchObject([{ id: created.threadId, name: "Renamed" }]);
  session.stop();
});

test("Claude questions support multiple answers, invalid retries, and bypass permissions", async () => {
  const asked = signal(); let permission: PermissionResult | undefined;
  const native = { questions: [{ header: "Parts", question: "Which parts?", multiSelect: true, options: [{ label: "API", description: "Server" }, { label: "UI", description: "Browser" }] }] };
  const fake = sdk(async function* (_input, options) {
    const pending = options.canUseTool!("AskUserQuestion", native, { signal: new AbortController().signal } as Parameters<CanUseTool>[2]);
    asked.resolve(); permission = await pending; yield result;
  });
  const session = new ClaudeSession(undefined, fake); const manager = new SessionManager(undefined, sessionProviders(() => session));
  // Bypass suppresses permission review but not the user's own answers.
  const { threadId } = await manager.createThread({ provider: "claude", policy: POLICY_PRESETS.bypass }); await manager.submitTurn(threadId, { input: [toTextUserInput("choose")] }); await asked.promise;
  const approval = manager.listApprovals(threadId)[0]!;
  expect(approval.userInput!.questions[0]).toMatchObject({ id: "question-0", multiSelect: true });
  await expect(manager.applyApprovalDecision(threadId, approval.approvalId, { decision: approval.choices.find(choice => choice.intent === "answer")!.value, answers: {} })).rejects.toThrow("Answer every question");
  expect(manager.listApprovals(threadId)[0]!.status).toBe("pending");
  await manager.applyApprovalDecision(threadId, approval.approvalId, { decision: approval.choices.find(choice => choice.intent === "answer")!.value, answers: { "question-0": ["API", "UI"] } }); await done(session);
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
    const session = new ClaudeSession(undefined, fake); const manager = new SessionManager(undefined, sessionProviders(() => session));
    // Bypass suppresses permission review but not the user's own answers.
  const { threadId } = await manager.createThread({ provider: "claude", policy: POLICY_PRESETS.bypass }); await manager.submitTurn(threadId, { input: [toTextUserInput("choose")] }); await asked.promise;
    const approval = manager.listApprovals(threadId)[0]!;
    if (cancelled) await manager.applyApprovalDecision(threadId, approval.approvalId, { decision: approval.choices.find(choice => choice.intent === "cancel")!.value }); else controller.abort();
    await done(session); expect(permission!.behavior).toBe("deny"); expect(manager.getRuntimeActivity().pendingApprovalIds).toEqual([]);
    await expect(session.applyApprovalDecision(approval.approvalId, { decision: approval.choices.find(choice => choice.intent === "cancel")!.value })).rejects.toThrow("Unknown Claude"); manager.stopAll();
  }
});

test("capabilities reach thread state and reject unsupported controls in the application", async () => {
  const fake = sdk(async function* () { yield result; }); const session = new ClaudeSession(undefined, fake);
  const manager = new SessionManager(undefined, sessionProviders(() => session), undefined, undefined, ["claude"]); const { threadId } = await manager.createThread({ provider: "claude" });
  expect(manager.getThreadState(threadId)).toMatchObject({ provider: "claude", capabilities: { questions: true, skills: false, compact: false, revert: false, fork: true } });
  expect((await manager.listLoadedThreads({})).threadIds).toContain(threadId);
  await expect(manager.compactThread(threadId)).rejects.toThrow("does not support compact");
  await expect(manager.listSkills(threadId, {})).rejects.toThrow("does not support skills"); manager.stopAll();
});

test("background tasks retain the SDK stream, prevent restart, and record later wake turns", async () => {
  const { InputQueue } = await import("../server/providers/claude/input_queue.js");
  const events = new InputQueue<SDKMessage>();
  const fake = sdk(async function* () { for await (const event of events) yield event; });
  const session = new ClaudeSession(undefined, fake);
  const manager = new SessionManager(undefined, sessionProviders(() => session), undefined, undefined, ["claude"]); const { threadId } = await manager.createThread({ provider: "claude" });
  const turns = async () => (await session.listThreadTurns(threadId, { sortDirection: "asc" })).data;
  function waitFor(type: string) { return new Promise<void>(resolve => { const off = session.eventBus.subscribe(event => { if (event.type === type) { off(); resolve(); } }, { replay: false }); }); }
  await manager.submitTurn(threadId, { input: [toTextUserInput("background work")] });
  const closedBeforeResult = fake.closed();
  const callsBeforeResult = fake.calls.length;
  const first = done(session);
  events.push({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "task-1", ambient: false }] } as SDKMessage);
  events.push(result); await first;
  expect(session.activeTurnId).toBeNull(); expect(fake.closed()).toBe(closedBeforeResult);
  expect(manager.getRuntimeActivity().activeTurnThreadIds).toEqual([threadId]);
  await expect(session.startTurn([toTextUserInput("change")], { model: "opus" })).rejects.toThrow("Wait for background tasks");
  expect(fake.calls).toHaveLength(callsBeforeResult);
  const started = waitFor("turn.started"); const completed = waitFor("turn.completed");
  events.push({ type: "assistant", parent_tool_use_id: null, message: { id: "wake-message", content: [{ type: "text", text: "Background result" }] } } as SDKMessage);
  await started; events.push(result); await completed;
  expect(await turns()).toHaveLength(2);
  expect((await turns())[1]!.items).toMatchObject([{ type: "assistant_message", text: "Background result" }]);
  const cleared = waitFor("thread.status.changed");
  events.push({ type: "system", subtype: "background_tasks_changed", tasks: [] } as SDKMessage); await cleared;
  expect(manager.getRuntimeActivity().activeTurnThreadIds).toEqual([]);
  await manager.submitTurn(threadId, { input: [toTextUserInput("continue")] });
  const third = done(session); events.push(result); await third;
  expect(fake.calls).toHaveLength(callsBeforeResult); expect(await turns()).toHaveLength(3);
  manager.stopAll(); events.close();
});

test("shutdown ends the running turn as interrupted before the SDK iterator finishes", async () => {
  const gate = signal();
  const fake = sdk(async function* () { await gate.promise; yield result; });
  const session = new ClaudeSession(undefined, fake); const { threadId } = await session.startThread({});
  await session.startTurn([toTextUserInput("wait")]); session.stop();
  const [turn] = (await session.listThreadTurns(threadId, {})).data;
  expect(turn).toMatchObject({ status: "interrupted" });
  expect(turn!.completedAt).toBeNumber();
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
  const session = new ClaudeSession(undefined, fake);
  const pending = session.listModels({}); await created.promise; session.stop();
  await expect(pending).rejects.toThrow("Discovery closed"); expect(fake.closed()).toBe(1);
  await expect(session.listModels({})).rejects.toThrow("Session is stopped");
});

test("loaded conversations include every provider and respect page size", async () => {
  const fake = sdk(async function* () { yield result; });
  const manager = new SessionManager(undefined, sessionProviders((tools, provider) => {
    if (provider === "claude") return new ClaudeSession(tools, fake);
    const session = new CodexSession(tools); session.initialize = async () => {};
    session.startThread = async () => ({ threadId: "opaque-codex-id", cwd: "/tmp", model: "codex", effort: null, profile: null });
    session.listLoadedThreads = async () => ({ data: ["opaque-codex-id"], nextCursor: null }); return session;
  }), undefined, undefined, ["codex", "claude"]);
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
  const session = new ClaudeSession(undefined, fake); const manager = new SessionManager(undefined, sessionProviders(() => session));
  const { threadId } = await manager.createThread({ provider: "claude" }); await manager.submitTurn(threadId, { input: [toTextUserInput("start")] }); await done(session);
  gate.resolve(); await asked.promise;
  const request = manager.listApprovals(threadId).find(approval => approval.status === "pending")!;
  expect(request.userInput!.turnId).toBe(session.activeTurnId);
  await expect(Promise.resolve().then(() => session.setCwd("/different"))).rejects.toThrow("Wait for Claude work");
  await manager.applyApprovalDecision(threadId, request.approvalId, { decision: request.choices.find(choice => choice.intent === "answer")!.value, answers: { "question-0": ["Yes"] } }); await done(session);
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
  const session = new ClaudeSession(undefined, fake, {
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
  const session = new ClaudeSession(undefined, fake, { scope: () => "scope", observe() { throw new Error("Must not observe an unknown account"); } });
  try {
    await session.startThread({ cwd: "/project" });
    await session.startTurn([toTextUserInput("hello")]); await done(session);
    expect(session.activeTurnId).toBeNull();
  } finally { session.stop(); }
});

test("new Claude defaults reach SDK turns; resumed conversations keep Claude's model and use host defaults otherwise", async () => {
  const previousModel = process.env.CLAUDE_MODEL; const previousEffort = process.env.CLAUDE_EFFORT;
  delete process.env.CLAUDE_MODEL; delete process.env.CLAUDE_EFFORT;
  const fake = sdk(async function* (_input, options) {
    yield { type: "system", subtype: "init", session_id: options.resume ?? options.sessionId } as SDKMessage;
    // Claude records the model that answered, not the alias or effort requested.
    yield { type: "assistant", parent_tool_use_id: null, message: { id: "answer", model: "claude-sonnet-5-5", content: [{ type: "text", text: "Hi" }] } } as SDKMessage;
    yield result;
  });
  const session = new ClaudeSession(undefined, fake);
  const resumed = new ClaudeSession(undefined, fake);
  const forked = new ClaudeSession(undefined, fake);
  try {
    const created = await session.startThread({ cwd: "/project" });
    expect(created).toMatchObject({ model: "claude-opus-5-5", effort: "medium" });
    await session.startTurn([toTextUserInput("hello")]); await done(session);
    expect(fake.calls[0]!.options).toMatchObject({ model: "claude-opus-5-5", effort: "medium" });
    process.env.CLAUDE_MODEL = "haiku"; process.env.CLAUDE_EFFORT = "low";
    expect(await resumed.resumeThread(created.threadId, {})).toMatchObject({ model: "claude-sonnet-5-5", effort: "low", cwd: "/project" });
    expect(await forked.forkThread(created.threadId, {})).toMatchObject({ model: "claude-sonnet-5-5", effort: "low" });
    expect(await new ClaudeSession(undefined, fake).resumeThread(created.threadId, { model: "opus", effort: "high" })).toMatchObject({ model: "opus", effort: "high" });
    const explicit = new ClaudeSession(undefined, fake);
    expect(await explicit.startThread({ model: "opus" })).toMatchObject({ model: "opus", effort: "low" });
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
  const manager = new SessionManager(undefined, sessionProviders((tools) => new ClaudeSession(tools, fake)));
  try {
    const { threadId } = await manager.createThread({ provider: "claude", model: "claude-opus-5-5" });
    expect(await manager.getThreadEffort(threadId)).toMatchObject({ model: "claude-opus-5-5", currentEffort: "medium", defaultEffort: "medium" });
    expect(await manager.setThreadEffort(threadId, { mode: "default" })).toMatchObject({ pendingEffort: "medium" });
    const legacy = await manager.createThread({ provider: "claude", model: "opus" });
    expect(await manager.getThreadEffort(legacy.threadId)).toMatchObject({ model: "opus", currentEffort: "medium" });
    expect((await manager.listModels({ provider: "claude" })).data.map(row => row.id)).toEqual(["claude-opus-5-5"]);
  } finally { manager.stopAll(); }
});

test("Claude history records thinking as reasoning and proposed plans as plans, in order", async () => {
  const assistant = (id: string, block: unknown) => ({ type: "assistant", parent_tool_use_id: null, message: { id, content: [block] } }) as SDKMessage;
  const fake = sdk(async function* () {
    yield assistant("m1", { type: "text", text: "Looking first." });
    yield assistant("m1", { type: "thinking", thinking: "The parser drops empty lines.", signature: "s" });
    yield assistant("m1", { type: "redacted_thinking", data: "opaque" });
    yield assistant("m1", { type: "thinking", thinking: "x".repeat(9_000), signature: "s" });
    yield assistant("m1", { type: "tool_use", id: "tool-plan", name: "ExitPlanMode", input: { plan: "1. Fix the parser.\n2. Add a test." } });
    yield { type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "tool-plan", content: "approved", is_error: false }] } } as SDKMessage;
    yield assistant("m2", { type: "text", text: "Done." });
    yield result;
  });
  const session = new ClaudeSession(undefined, fake);
  try {
    const { threadId } = await session.startThread({});
    await session.startTurn([toTextUserInput("fix it")]); await done(session);
    const items = (await session.listThreadTurns(threadId, {})).data[0]!.items;
    expect(items.map(item => item.type)).toEqual(["user_message", "assistant_message", "reasoning", "reasoning", "plan", "activity", "assistant_message"]);
    expect(items[1]).toMatchObject({ text: "Looking first.", phase: "interim" });
    // Claude's thinking is the reasoning itself, not a summary of it.
    expect(items[2]).toMatchObject({ form: "full", parts: ["The parser drops empty lines."] });
    expect((items[3] as { parts: string[] }).parts[0]).toEndWith("[1000 characters omitted]");
    expect(items[4]).toMatchObject({ type: "plan", text: "1. Fix the parser.\n2. Add a test." });
    expect(new Set(items.map(item => item.id)).size).toBe(items.length);
    expect((await session.listThreadTurns(threadId, { itemsView: "summary" })).data[0]!.items.map(item => item.type)).toEqual(["user_message", "assistant_message"]);
  } finally { session.stop(); }
});

test("per-block assistant messages mark text before tools as interim and the last text as the answer", async () => {
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
  const session = new ClaudeSession(undefined, fake);
  const { threadId } = await session.startThread({});
  const events: BridgeEvent[] = []; session.eventBus.subscribe(event => events.push(event), { replay: false });
  await session.startTurn([toTextUserInput("run tests")]); await done(session);
  expect(events.flatMap(event => event.type === "item.delta" ? [event.payload.itemId] : [])).toEqual(["plan", "answer", "answer:1"]);
  const history = (await session.listThreadTurns(threadId, {})).data[0]!.items;
  expect(history.map(item => [item.id, item.type === "assistant_message" ? item.phase ?? null : null])).toEqual([
    [expect.any(String), null], ["plan", "interim"], ["tool-1", null], ["answer", "final"], ["answer:1", "final"],
  ]);
  // Live delivery and history agree: every item completed live is the record history returns.
  expect(events.flatMap(event => event.type === "item.completed" ? [event.payload.item] : [])).toEqual(history.filter(item => item.type !== "user_message"));
  expect(events.find(event => event.type === "item.started")?.payload).toEqual({ turnId: expect.any(String), item: { id: "tool-1", type: "activity", status: "started", activity: { kind: "command", command: "bun test", cwd: null } } });
  const chat = events.reduce(reduceBridge, emptyChat());
  expect(timelineGroups(chat).flatMap(group => group.finalIds)).toEqual(["answer", "answer:1"]);
  session.stop();
});

test("subagent work joins its delegation live and in history, including a background subagent that finishes after the turn", async () => {
  const assistant = (id: string, block: unknown, parent: string | null = null) => ({ type: "assistant", parent_tool_use_id: parent, ...(parent ? { agent_id: "agent-1" } : {}), message: { id, content: [block] } }) as SDKMessage;
  const toolResult = (id: string, parent: string | null = null) => ({ type: "user", parent_tool_use_id: parent, ...(parent ? { agent_id: "agent-1" } : {}), message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok", is_error: false }] } }) as SDKMessage;
  const { InputQueue } = await import("../server/providers/claude/input_queue.js");
  const later = new InputQueue<SDKMessage>();
  const fake = sdk(async function* (input) {
    for await (const _ of input) break;
    yield assistant("main", { type: "tool_use", id: "agent-call", name: "Agent", input: { description: "Survey", prompt: "Look around", subagent_type: "Explore", run_in_background: true } });
    yield assistant("sub-1", { type: "text", text: "Looking at the repo." }, "agent-call");
    yield assistant("sub-1", { type: "tool_use", id: "sub-tool", name: "Bash", input: { command: "ls" } }, "agent-call");
    yield toolResult("agent-call");
    yield assistant("answer", { type: "text", text: "Started a survey." });
    yield result;
    for await (const event of later) yield event;
  });
  const session = new ClaudeSession(undefined, fake);
  const { threadId } = await session.startThread({});
  const events: BridgeEvent[] = []; session.eventBus.subscribe(event => events.push(event), { replay: false });
  await session.startTurn([toTextUserInput("survey")]); await done(session);
  // The background subagent keeps working after its turn's result.
  const finished = new Promise<void>(resolve => { const off = session.eventBus.subscribe(event => { if (event.type === "item.completed" && event.payload.item.id === "sub-2") { off(); resolve(); } }, { replay: false }); });
  later.push(toolResult("sub-tool", "agent-call"));
  later.push(assistant("sub-2", { type: "text", text: "The repo has tests." }, "agent-call"));
  await finished;
  const live = events.flatMap(event => event.type === "item.completed" ? [event.payload.item] : []);
  expect(live.filter(item => item.parentItemId).map(item => [item.id, item.type, item.type === "assistant_message" ? item.phase : null])).toEqual([
    ["sub-1", "assistant_message", "interim"], ["sub-tool", "activity", null], ["sub-2", "assistant_message", "interim"],
  ]);
  expect(live.every(item => !item.parentItemId || item.parentItemId === "agent-call")).toBe(true);
  // The stored session and subagent transcripts decode to what was delivered live. Transcripts
  // record no results, so the conversation's own items and its subagents' are each in order, but
  // their interleaving is by time.
  session.stop(); later.close();
  const reader = new ClaudeSession(undefined, fake);
  const history = (await reader.listThreadTurns(threadId, {})).data;
  expect(history).toHaveLength(1);
  const own = (items: HistoryItem[]) => items.filter(item => !item.parentItemId && item.type !== "user_message");
  const children = (items: HistoryItem[]) => items.filter(item => item.parentItemId);
  expect(own(history[0]!.items).map(item => item.id)).toEqual(["agent-call", "answer"]);
  expect(own(history[0]!.items)).toEqual(own(live));
  expect(children(history[0]!.items)).toEqual(children(live));
  // A subagent's text is never the answer, and its rows nest under the delegation.
  const chat = events.reduce(reduceBridge, emptyChat());
  expect(timelineGroups(chat).flatMap(group => group.finalIds)).toEqual(["answer"]);
  expect(chat.messages.filter(message => message.parentId === "agent-call").map(message => message.id)).toEqual(["sub-1", "sub-tool", "sub-2"]);
  expect(timelineGroups(chat).flatMap(group => group.messages.map(message => message.id))).not.toContain("sub-2");
  reader.stop();
});

test("thinking streams as reasoning under the item ID history records it with", async () => {
  const stream = (event: unknown) => ({ type: "stream_event", parent_tool_use_id: null, event }) as SDKMessage;
  const assistant = (block: unknown) => ({ type: "assistant", parent_tool_use_id: null, message: { id: "m", content: [block] } }) as SDKMessage;
  const fake = sdk(async function* (input) {
    for await (const _ of input) break;
    yield stream({ type: "message_start", message: { id: "m", usage: {} } });
    // A thinking block without text is not recorded, so it takes no index.
    yield stream({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
    yield stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: " " } });
    yield assistant({ type: "thinking", thinking: " " });
    yield stream({ type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "" } });
    yield stream({ type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "\n" } });
    yield stream({ type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "Check" } });
    yield stream({ type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: " the logs." } });
    yield assistant({ type: "thinking", thinking: "\nCheck the logs." });
    yield stream({ type: "content_block_start", index: 2, content_block: { type: "text", text: "" } });
    yield stream({ type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "Done." } });
    yield assistant({ type: "text", text: "Done." });
    yield result;
  });
  const session = new ClaudeSession(undefined, fake);
  const { threadId } = await session.startThread({});
  const events: BridgeEvent[] = []; session.eventBus.subscribe(event => events.push(event), { replay: false });
  await session.startTurn([toTextUserInput("think")]); await done(session);
  const reasoning = events.flatMap(event => event.type === "item.delta" && event.payload.channel === "reasoning" ? [event.payload] : []);
  expect(reasoning.map(delta => [delta.itemId, delta.delta])).toEqual([["m:thinking:0", "\nCheck"], ["m:thinking:0", " the logs."]]);
  const history = (await session.listThreadTurns(threadId, {})).data[0]!.items;
  expect(history.filter(item => item.type === "reasoning")).toEqual([{ id: "m:thinking:0", type: "reasoning", form: "full", parts: ["\nCheck the logs."] }]);
  // The web view shows the reasoning while it streams, then the canonical item in its place.
  const chat = events.reduce(reduceBridge, emptyChat());
  expect(chat.messages.filter(message => message.id === "m:thinking:0").map(message => [message.activity?.status, message.activity?.activity.kind === "other" ? message.activity.activity.title : null])).toEqual([["completed", "Reasoning"]]);
  expect(reasoning.every(delta => delta.form === "full")).toBe(true);
  session.stop();
});

test("per-request cache counts the SDK omits are unreported, not zero", async () => {
  const fake = sdk(async function* () {
    yield { type: "assistant", parent_tool_use_id: null, message: { id: "m", usage: { input_tokens: 7, output_tokens: 2 }, content: [{ type: "text", text: "Done" }] } } as SDKMessage;
    yield result;
  });
  const session = new ClaudeSession(undefined, fake);
  await session.startThread({});
  const updates: unknown[] = []; session.eventBus.subscribe(event => { if (event.type === "thread.tokenUsage.updated") updates.push(event.payload); }, { replay: false });
  await session.startTurn([toTextUserInput("hello")]); await done(session);
  expect(updates).toMatchObject([{ tokenUsage: { last: { inputTokens: null, cacheReadInputTokens: null, cacheWriteInputTokens: null, outputTokens: 2, totalTokens: null } } }]);
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
  const session = new ClaudeSession(undefined, fake);
  await session.startThread({ model: "claude-opus-5-5" });
  const updates: unknown[] = []; session.eventBus.subscribe(event => { if (event.type === "thread.tokenUsage.updated") updates.push(event.payload); }, { replay: false });
  await session.startTurn([toTextUserInput("hello")]); await done(session);
  expect(updates).toMatchObject([{ tokenUsage: {
    last: { inputTokens: 1015, cacheReadInputTokens: 1000, cacheWriteInputTokens: 5, outputTokens: 50, reasoningOutputTokens: null, totalTokens: 1065 },
    total: { inputTokens: 1015, cacheReadInputTokens: 1000, cacheWriteInputTokens: 5, reasoningOutputTokens: null },
    contextWindow: 200_000,
  } }]);
  session.stop();
});

test("forking a Claude session lets the SDK find its transcript, and the fork resumes in its own workspace", async () => {
  const fake = sdk(async function* (_input, options) { yield { type: "system", subtype: "init", session_id: options.resume ?? options.sessionId } as SDKMessage; yield result; });
  const source = new ClaudeSession(undefined, fake);
  const created = await source.startThread({ cwd: "/workspace-a" });
  await source.startTurn([toTextUserInput("first")]); await done(source);
  const fork = new ClaudeSession(undefined, fake);
  const forked = await fork.forkThread(created.threadId, {});
  // No project directory is passed, so the SDK searches every one for the transcript.
  expect(fake.forks).toEqual([[created.threadId]]);
  fork.setCwd("/workspace-c"); await fork.startTurn([toTextUserInput("continue")]); await done(fork);
  expect(fake.calls[1]!.options).toMatchObject({ cwd: "/workspace-c", resume: forked.threadId });
  source.stop(); fork.stop();
});

test("activities come from a bounded subset of tool arguments; tool results never reach history", async () => {
  const fake = sdk(async function* (_input, options) {
    yield { type: "system", subtype: "init", session_id: options.resume ?? options.sessionId } as SDKMessage;
    for (let index = 0; index < 2; index++) {
      yield { type: "assistant", parent_tool_use_id: null, message: { id: `m${index}`, content: [{ type: "tool_use", id: `tool-${index}`, name: index ? "Write" : "Read", input: { file_path: index ? "x".repeat(20_000) : "/project/a.ts", content: "secret body" } }] } } as SDKMessage;
      yield { type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: `tool-${index}`, content: "private result", is_error: false }] } } as SDKMessage;
    }
    yield result;
  });
  const session = new ClaudeSession(undefined, fake);
  const { threadId } = await session.startThread({});
  await session.startTurn([toTextUserInput("read")]); await done(session);
  const items = (await session.listThreadTurns(threadId, {})).data[0]!.items;
  expect(items[1]).toEqual({ id: "tool-0", type: "activity", status: "completed", activity: { kind: "tool", source: "builtin", server: null, name: "Read", target: "/project/a.ts" } });
  expect(JSON.stringify(items)).not.toContain("secret body");
  expect(JSON.stringify(items)).not.toContain("private result");
  expect(items[2]!.type === "activity" && items[2]!.activity.kind === "file_change" && items[2]!.activity.paths[0]!.length).toBeLessThan(8_100);
  session.stop();
});

test("the model catalog is cached and concurrent lookups share one CLI process", async () => {
  const fake = sdk(async function* () { yield result; });
  const session = new ClaudeSession(undefined, fake);
  await Promise.all([session.listModels({}), session.listModels({})]);
  await session.listModels({ includeHidden: true });
  expect(fake.calls).toHaveLength(1);
  session.stop();
});

test("sessions sharing a runtime model cache start one CLI process for the model list", async () => {
  const fake = sdk(async function* () { yield result; });
  const models = new ClaudeModelCache({ scope: () => "login" });
  const first = new ClaudeSession(undefined, fake, undefined, models);
  const second = new ClaudeSession(undefined, fake, undefined, models);
  await first.listModels({}); await second.listModels({});
  expect(fake.calls).toHaveLength(1);
  first.stop(); second.stop();
});

test("newly registered Shepherd tools reopen the idle SDK process before the next turn", async () => {
  const registry = new DynamicToolRegistry();
  const fake = sdk(async function* (input) { for await (const _message of input) yield result; });
  const session = new ClaudeSession(registry, fake);
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

test("stored transcripts decode prompts, steering, interruptions and background work into turns", () => {
  let clock = 0;
  const entry = (type: "user" | "assistant", message: unknown, extra: Partial<TranscriptEntry> = {}): TranscriptEntry => ({ type, uuid: extra.uuid ?? randomUUID(), message, parent_tool_use_id: null, timestamp: new Date(++clock * 1000).toISOString(), ...extra });
  const { turns, model, usage } = decodeTranscript([
    entry("user", { role: "user", content: "Fix the build" }, { uuid: "prompt-1" }),
    entry("assistant", { id: "m1", model: "claude-opus-5-5", content: [{ type: "thinking", thinking: "Check the logs." }] }),
    entry("assistant", { id: "m1", content: [{ type: "text", text: "Looking." }] }),
    entry("assistant", { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "bun run build" } }] }),
    entry("user", { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "error", is_error: true }] }),
    // Subagent work joins its delegation as interim progress, never the answer.
    entry("assistant", { id: "sub", content: [{ type: "text", text: "Subagent detail" }] }, { parent_tool_use_id: "t1" }),
    entry("assistant", { id: "m2", content: [{ type: "text", text: "Fixed it." }], usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 1, cache_creation_input_tokens: 0 } }),
    entry("user", { role: "user", content: [{ type: "text", text: "Also run tests" }] }, { uuid: "steer-1", isQueuedCommand: true }),
    entry("assistant", { id: "m3", content: [{ type: "text", text: "Tests pass." }] }),
    entry("user", { role: "user", content: "Deploy it" }, { uuid: "prompt-2" }),
    entry("assistant", { id: "m4", content: [{ type: "text", text: "Starting." }] }),
    entry("user", { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] }),
    entry("user", { role: "user", content: "<task-notification>done</task-notification>" }, { uuid: "wake-1", origin: { kind: "task-notification" } }),
    entry("assistant", { id: "m5", content: [{ type: "text", text: "The task finished." }] }),
  ]);
  expect(model).toBe("claude-opus-5-5");
  expect(usage).toMatchObject({ input_tokens: 5 });
  expect(turns.map(turn => [turn.id, turn.status])).toEqual([["prompt-1", "completed"], ["prompt-2", "interrupted"], ["wake-1", "completed"]]);
  expect(turns[0]!.items.map(item => [item.id, item.type, item.type === "assistant_message" ? item.phase : item.type === "activity" ? item.status : null])).toEqual([
    ["prompt-1", "user_message", null], ["m1:thinking:0", "reasoning", null], ["m1", "assistant_message", "interim"], ["t1", "activity", "failed"], ["sub", "assistant_message", "interim"],
    // Steering is recorded once the response before it has finished, so that response's text answered it.
    ["m2", "assistant_message", "final"], ["steer-1", "user_message", null], ["m3", "assistant_message", "final"],
  ]);
  expect(turns[0]!.durationMs).toBe(8_000);
  expect(turns[1]!.items).toEqual([{ id: "prompt-2", type: "user_message", content: [{ type: "text", text: "Deploy it" }] }, { id: "m4", type: "assistant_message", text: "Starting.", phase: "interim" }]);
  // Background notifications are not the user's words.
  expect(turns[2]!.items).toEqual([{ id: "m5", type: "assistant_message", text: "The task finished.", phase: "final" }]);
  // A turn still running in this process stays in progress, with its text not yet classified.
  const running = decodeTranscript([entry("user", { role: "user", content: "Go" }, { uuid: "live" }), entry("assistant", { id: "m6", content: [{ type: "text", text: "Working" }] })], "live");
  expect(running.turns).toMatchObject([{ id: "live", status: "in_progress", items: [{ type: "user_message" }, { id: "m6", text: "Working" }] }]);
  expect(running.turns[0]!.items[1]).not.toHaveProperty("phase");
});

test("conversation listing reads Claude's sessions, filters archived and search, and sorts", async () => {
  const fake = sdk(async function* (_input, options) { yield { type: "system", subtype: "init", session_id: options.resume ?? options.sessionId } as SDKMessage; yield result; });
  const provider = new ClaudeProvider(fake);
  const ids: string[] = [];
  for (const prompt of ["alpha task", "beta task", "gamma"]) {
    const session = provider.openSession(noProviderTools); const { threadId } = await session.startThread({ cwd: `/${prompt.split(" ")[0]}` });
    await session.startTurn([toTextUserInput(prompt)]); await done(session); session.stop(); ids.push(threadId);
  }
  // The provider reads stored conversations without opening a session.
  await provider.archiveThread(ids[1]!);
  expect((await provider.listStoredThreads({})).data.map(thread => thread.preview)).toEqual(["gamma", "alpha task"]);
  expect((await provider.listStoredThreads({ archived: true })).data.map(thread => thread.id)).toEqual([ids[1]]);
  expect((await provider.listStoredThreads({ searchTerm: "TASK" })).data.map(thread => thread.id)).toEqual([ids[0]]);
  expect((await provider.listStoredThreads({ sortDirection: "asc", cwd: ["/alpha", "/gamma"] })).data.map(thread => thread.cwd)).toEqual(["/alpha", "/gamma"]);
  expect((await provider.listThreadTurns(ids[0]!, {})).data).toMatchObject([{ items: [{ type: "user_message", content: [{ text: "alpha task" }] }] }]);
  expect(fake.calls).toHaveLength(3);
  const resumed = provider.openSession(noProviderTools);
  await expect(resumed.resumeThread("00000000-0000-4000-8000-000000000000", {})).rejects.toThrow("Unknown Claude session");
  provider.stop();
});

test("Claude applies opaque permission options through the shared session boundary", async () => {
  const asked = signal(), decisions: PermissionResult[] = [];
  const fake = sdk(async function* (_input, options) {
    const pending = options.canUseTool!("Read", { file_path: "/project/readme.md" }, { signal: new AbortController().signal, suggestions: [] } as Parameters<CanUseTool>[2]);
    asked.resolve(); decisions.push(await pending); yield result;
  });
  const session = new ClaudeSession(undefined, fake), manager = new SessionManager(undefined, sessionProviders(() => session));
  const { threadId } = await manager.createThread({ provider: "claude", cwd: "/project" });
  const observed: BridgeEvent[] = [];
  manager.subscribeToThreadEvents(threadId, event => observed.push(event));
  await manager.submitTurn(threadId, { input: [toTextUserInput("read")] }); await asked.promise;
  const pending = manager.listApprovals(threadId)[0]!;
  expect(pending.kind).toBe("permission"); expect(pending.activity).toEqual({ kind: "tool", source: "builtin", server: null, name: "Read", target: "/project/readme.md" });
  expect(pending.choices.map(choice => choice.intent)).toEqual(["allow", "deny"]);
  expect(pending.choices.some(choice => ["allow", "deny"].includes(choice.value))).toBe(false);
  await manager.applyApprovalDecision(threadId, pending.approvalId, { decision: pending.choices.find(choice => choice.intent === "allow")!.value });
  await done(session);
  expect(decisions).toEqual([{ behavior: "allow", updatedInput: { file_path: "/project/readme.md" } }]);
  expect(manager.listApprovals(threadId).every(record => record.status !== "pending")).toBe(true);
  await expect(manager.applyApprovalDecision(threadId, pending.approvalId, { decision: pending.choices[0]!.value })).rejects.toThrow("already");
  manager.stopAll();
});

test("Claude profiles map to SDK permission modes, and every bootstrap states its profile", async () => {
  const modes = { bypassPermissions: ["bypassPermissions", true], default: ["default", undefined], plan: ["plan", undefined] } as const;
  for (const [profile, [permissionMode, skip]] of [...Object.entries(modes), [null, [undefined, undefined]]] as Array<[string | null, readonly [string | undefined, boolean | undefined]]>) {
    const fake = sdk(async function* (input, options) { for await (const _message of input) { yield { type: "system", subtype: "init", session_id: options.resume ?? options.sessionId } as SDKMessage; yield result; break; } });
    const original = new ClaudeSession(undefined, fake);
    const created = await original.startThread({ effort: "high", profile });
    expect(created.profile).toBe(profile);
    await original.startTurn([toTextUserInput("Start")]); await done(original); original.stop();
    // Without a profile, Claude's settings choose the permission mode.
    expect(fake.calls[0]!.options).toMatchObject({ effort: "high" });
    expect(fake.calls[0]!.options.permissionMode).toBe(permissionMode);
    expect(fake.calls[0]!.options.allowDangerouslySkipPermissions).toBe(skip);
    // Claude's session does not record Shepherd's profile, so resume and fork use the one they are given.
    const resumed = new ClaudeSession(undefined, fake), forked = new ClaudeSession(undefined, fake);
    try {
      expect(await resumed.resumeThread(created.threadId, { profile: "plan" })).toMatchObject({ profile: "plan" });
      expect(await forked.forkThread(created.threadId, {})).toMatchObject({ profile: null });
    } finally { resumed.stop(); forked.stop(); }
  }
});

test("core picks Claude's least restrictive profile within the requested policy, and refuses a stricter one it lacks", async () => {
  const fake = sdk(async function* () { yield result; });
  const manager = new SessionManager(undefined, sessionProviders(tools => new ClaudeSession(tools, fake)), undefined, undefined, ["claude"], "claude", { policy: POLICY_PRESETS.review });
  try {
    const host = await manager.createThread({});
    expect(manager.getThreadState(host.threadId).policy).toEqual({ profile: "default", policy: POLICY_PRESETS.review });
    // Read-only writes allow Claude's plan mode.
    const readOnly = await manager.createThread({ policy: POLICY_PRESETS.read_only });
    expect(manager.getThreadState(readOnly.threadId).policy?.profile).toBe("plan");
    // Claude has no mode that blocks the network, so it refuses rather than loosen the policy.
    await expect(manager.createThread({ policy: { writes: "none", network: "none", review: "risky" } })).rejects.toThrow("execution policy");
  } finally { manager.stopAll(); }
});

test("Claude clears effort by restarting with no SDK effort and keeps it cleared", async () => {
  const fake = sdk(async function* (input) { for await (const _message of input) { yield result; } });
  const session = new ClaudeSession(undefined, fake);
  try {
    const { threadId } = await session.startThread({});
    await session.startTurn([toTextUserInput("first")]); await done(session);
    expect(fake.calls[0]!.options.effort).toBe("medium");
    await session.startTurn([toTextUserInput("second")], { effort: null }); await done(session);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]!.options.effort).toBeUndefined();
    expect((await session.readThread(threadId, false)).thread.id).toBe(threadId);
    await session.startTurn([toTextUserInput("third")]); await done(session);
    expect(fake.calls).toHaveLength(2);
  } finally { session.stop(); }
});
