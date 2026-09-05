import { describe, expect, spyOn, test } from "bun:test";

import type { BridgeEvent } from "../shared/protocol/events.js";
import { CodexSession } from "../server/core/codex_session.js";
import { DynamicToolRegistry } from "../server/core/dynamic_tool_registry.js";
import { extractThreadSummary } from "../server/core/session_manager.js";

type SessionInternals = {
  start: () => Promise<void>;
  sendRequest: (method: string, params?: unknown) => Promise<unknown>;
  sendNotification: (method: string) => void;
  writeLine: (payload: unknown) => void;
  onServerStderr: (chunk: Buffer) => void;
  onNotification: (method: string, params: unknown) => void;
  onServerRequest: (request: { id: string | number; method: string; params: unknown }) => void;
};

function internals(session: CodexSession): SessionInternals {
  return session as unknown as SessionInternals;
}

describe("CodexSession app-server contract", () => {
  test("uses the generated initialize and initialized envelope shapes", async () => {
    const session = new CodexSession("on-request");
    const requests: Array<{ method: string; params: unknown }> = [];
    const notifications: string[] = [];
    const raw = internals(session);
    raw.start = async () => {};
    raw.sendRequest = async (method, params) => {
      requests.push({ method, params });
      return {};
    };
    raw.sendNotification = (method) => notifications.push(method);

    await session.initialize();

    expect(requests).toEqual([
      {
        method: "initialize",
        params: {
          capabilities: { experimentalApi: true },
          clientInfo: { name: "shepherd", title: "Shepherd", version: "1.0.0" },
        },
      },
    ]);
    expect(notifications).toEqual(["initialized"]);
  });

  test("advertises registered dynamic tools when starting a thread", async () => {
    const tools = new DynamicToolRegistry();
    tools.register({
      namespace: "shepherd",
      namespaceDescription: "Shepherd services.",
      name: "callback",
      description: "Create a callback.",
      inputSchema: { type: "object" },
      async execute() {
        return { success: true, contentItems: [] };
      },
    });
    const session = new CodexSession("on-request", tools);
    const requests: Array<{ method: string; params: unknown }> = [];
    session.initialize = async () => {};
    internals(session).sendRequest = async (method, params) => {
      requests.push({ method, params });
      return { thread: { id: "thread-1", modelProvider: "openai" } };
    };

    await session.startThread({ cwd: "/workspace" });

    expect(requests[0]?.method).toBe("thread/start");
    expect(requests[0]?.params).toMatchObject({
      cwd: "/workspace",
      dynamicTools: [{
        type: "namespace",
        name: "shepherd",
        description: "Shepherd services.",
        tools: [{
          type: "function",
          name: "callback",
          description: "Create a callback.",
          inputSchema: { type: "object" },
        }],
      }],
    });
  });

  test("dispatches a dynamic tool call only for the active thread and turn", async () => {
    const tools = new DynamicToolRegistry();
    const calls: unknown[] = [];
    tools.register({
      namespace: "shepherd",
      namespaceDescription: "Shepherd services.",
      name: "callback",
      description: "Create a callback.",
      inputSchema: { type: "object" },
      async execute(params) {
        calls.push(params);
        return { success: true, contentItems: [{ type: "inputText", text: "ready" }] };
      },
    });
    const session = new CodexSession("on-request", tools);
    session.threadId = "thread-1";
    session.activeTurnId = "turn-1";
    const writes: unknown[] = [];
    internals(session).writeLine = (payload) => writes.push(payload);

    internals(session).onServerRequest({
      id: 9,
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        namespace: "shepherd",
        tool: "callback",
        arguments: { kind: "build.finished" },
      },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(calls).toHaveLength(1);
    expect(writes).toEqual([{
      id: 9,
      result: { success: true, contentItems: [{ type: "inputText", text: "ready" }] },
    }]);

    internals(session).onServerRequest({
      id: 10,
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "stale-turn",
        callId: "call-2",
        namespace: "shepherd",
        tool: "callback",
        arguments: {},
      },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(writes.at(-1)).toEqual({
      id: 10,
      error: { code: -32602, message: "Dynamic tool call targets a stale turn." },
    });
  });

  test("omits params for parameterless requests and removed skill-list fields", async () => {
    const session = new CodexSession("on-request");
    const requests: Array<{ method: string; params: unknown }> = [];
    const raw = internals(session);
    session.initialize = async () => {};
    raw.sendRequest = async (method, params) => {
      requests.push({ method, params });
      return method === "skills/list" ? { data: [] } : {};
    };

    await session.readAccountRateLimits();
    await session.listSkills({ cwds: ["/workspace"], forceReload: true });

    expect(requests).toEqual([
      { method: "account/rateLimits/read", params: undefined },
      { method: "skills/list", params: { cwds: ["/workspace"], forceReload: true } },
    ]);
  });

  test("retains the effective approval policy returned by resume", async () => {
    const session = new CodexSession("on-request");
    session.initialize = async () => {};
    internals(session).sendRequest = async () => ({
      thread: { id: "thread-1", modelProvider: "openai" },
      model: "gpt-5.6-sol",
      approvalPolicy: {
        granular: {
          sandbox_approval: true,
          rules: false,
          skill_approval: true,
          request_permissions: false,
          mcp_elicitations: true,
        },
      },
    });

    await session.resumeThread("thread-1", {});

    expect(session.approvalPolicy).toEqual({
      granular: {
        sandbox_approval: true,
        rules: false,
        skill_approval: true,
        request_permissions: false,
        mcp_elicitations: true,
      },
    });
  });

  test("returns a JSON-RPC error for unsupported server requests", () => {
    const session = new CodexSession("on-request");
    const writes: unknown[] = [];
    const events: BridgeEvent[] = [];
    internals(session).writeLine = (payload) => writes.push(payload);
    session.eventBus.subscribe((event) => events.push(event), { replay: false });

    internals(session).onServerRequest({
      id: 7,
      method: "item/tool/requestUserInput",
      params: { questions: [] },
    });

    expect(writes).toEqual([
      {
        id: 7,
        error: {
          code: -32601,
          message: "Shepherd does not support server request item/tool/requestUserInput.",
        },
      },
    ]);
    expect(events.at(-1)?.type).toBe("session.error");
  });

  test("maps legacy denial to the generated structured decision", async () => {
    const session = new CodexSession("on-request");
    const writes: unknown[] = [];
    const events: BridgeEvent[] = [];
    internals(session).writeLine = (payload) => writes.push(payload);
    session.eventBus.subscribe((event) => events.push(event), { replay: false });

    internals(session).onServerRequest({
      id: "approval-7",
      method: "execCommandApproval",
      params: { reason: "Needs review" },
    });
    const requested = events.find((event) => event.type === "approval.requested");
    const approvalId = (requested?.payload as { approvalId?: string } | undefined)?.approvalId;
    if (!approvalId) throw new Error("Expected an approval request.");

    await session.applyApprovalDecision(approvalId, {
      decision: "denied",
      reason: "Not allowed here.",
    });

    expect(writes).toEqual([
      {
        id: "approval-7",
        result: {
          decision: { denied: { rejection: "Not allowed here." } },
        },
      },
    ]);
  });

  test("decodes nested error notifications and failed turns", () => {
    const session = new CodexSession("on-request");
    const events: BridgeEvent[] = [];
    session.threadId = "thread-bound";
    session.activeTurnId = "turn-active";
    session.eventBus.subscribe((event) => events.push(event), { replay: false });

    internals(session).onNotification("error", {
      threadId: "thread-schema",
      turnId: "turn-active",
      error: {
        message: "The context window was exceeded.",
        codexErrorInfo: "contextWindowExceeded",
      },
      willRetry: false,
    });
    internals(session).onNotification("turn/completed", {
      threadId: "thread-schema",
      turn: {
        id: "turn-active",
        status: "failed",
        error: { message: "Provider rejected the request." },
      },
    });

    expect(events.map((event) => [event.type, event.threadId, event.payload])).toEqual([
      [
        "session.limit.context",
        "thread-schema",
        { message: "The context window was exceeded.", method: "error" },
      ],
      [
        "turn.failed",
        "thread-schema",
        { message: "Provider rejected the request.", turnId: "turn-active" },
      ],
    ]);
    expect(session.activeTurnId).toBeNull();
  });

  test("keeps retry diagnostics out of the user-visible event stream", () => {
    const session = new CodexSession("on-request");
    const events: BridgeEvent[] = [];
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    session.threadId = "thread-1";
    session.eventBus.subscribe((event) => events.push(event), { replay: false });

    internals(session).onNotification("error", {
      threadId: "thread-1",
      error: { message: "Reconnecting... 2/5" },
      willRetry: true,
    });
    internals(session).onServerStderr(Buffer.from("Reconnecting... 3/5"));

    expect(events).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith("codex app-server retrying: Reconnecting... 2/5");
    expect(error).toHaveBeenCalledWith("codex app-server stderr: Reconnecting... 3/5");

    warn.mockRestore();
    error.mockRestore();
  });

  test("publishes an exhausted retry as one session error", () => {
    const session = new CodexSession("on-request");
    const events: BridgeEvent[] = [];
    session.threadId = "thread-1";
    session.eventBus.subscribe((event) => events.push(event), { replay: false });

    internals(session).onNotification("error", {
      threadId: "thread-1",
      error: { message: "Connection failed after 5 attempts." },
      willRetry: false,
    });

    expect(events.map((event) => [event.type, event.payload])).toEqual([
      ["session.error", { message: "Connection failed after 5 attempts." }],
    ]);
  });

  test("publishes normalized activity and canonical completed messages", () => {
    const session = new CodexSession("on-request");
    const events: BridgeEvent[] = [];
    session.threadId = "thread-1";
    session.activeTurnId = "turn-1";
    session.eventBus.subscribe((event) => events.push(event), { replay: false });

    internals(session).onNotification("item/started", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "commandExecution",
        id: "command-1",
        command: "bun test",
        status: "inProgress",
      },
    });
    internals(session).onNotification("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "imageGeneration",
        id: "image-1",
        status: "completed",
        revisedPrompt: "A pastel unicorn",
        result: "Image generated",
        savedPath: "/tmp/generated-unicorn.png",
      },
    });
    internals(session).onNotification("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "agentMessage",
        id: "final-1",
        phase: "final_answer",
        text: "Complete answer",
      },
    });

    expect(events.find((event) => event.type === "turn.activity")?.payload).toMatchObject({
      itemId: "command-1",
      turnId: "turn-1",
      kind: "command",
      detail: "bun test",
      status: "started",
    });
    expect(events.find((event) => event.type === "turn.message.completed")?.payload).toEqual({
      itemId: "final-1",
      phase: "final_answer",
      text: "Complete answer",
      turnId: "turn-1",
    });
    expect(events.find((event) => event.type === "turn.image.generated")?.payload).toEqual({
      itemId: "image-1",
      turnId: "turn-1",
      path: "/tmp/generated-unicorn.png",
      revisedPrompt: "A pastel unicorn",
    });
  });

  test("attaches turn and captured phase metadata to agent deltas", () => {
    const session = new CodexSession("on-request");
    const events: BridgeEvent[] = [];
    session.threadId = "thread-1";
    session.activeTurnId = "turn-1";
    session.eventBus.subscribe((event) => events.push(event), { replay: false });

    internals(session).onNotification("item/started", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "agentMessage",
        id: "comment-1",
        phase: "commentary",
        text: "",
      },
    });
    internals(session).onNotification("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "comment-1",
      delta: "Checking now.",
    });

    expect(events.find((event) => event.type === "turn.stream.delta")?.payload).toEqual({
      method: "item/agentMessage/delta",
      textDelta: "Checking now.",
      itemId: "comment-1",
      phase: "commentary",
      turnId: "turn-1",
    });
  });
});

describe("thread/list response mapping", () => {
  test("uses the request archive filter instead of notLoaded runtime status", () => {
    const thread = {
      id: "thread-1",
      name: null,
      preview: "hello",
      status: { type: "notLoaded" },
      createdAt: 1,
      updatedAt: 2,
      source: "cli",
      cwd: "/workspace",
    };

    expect(extractThreadSummary(thread, false).archived).toBe(false);
    expect(extractThreadSummary(thread, true).archived).toBe(true);
  });
});
