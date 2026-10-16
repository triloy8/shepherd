import { describe, expect, spyOn, test } from "bun:test";

import type { BridgeEvent } from "../shared/protocol/events.js";
import { CodexSession } from "../server/providers/codex/session.js";
import { DynamicToolRegistry } from "../server/core/dynamic_tool_registry.js";
import { extractThreadSummary } from "../server/core/session_manager.js";
import { fakeAppServer } from "./helpers/fake_app_server.js";

type SessionInternals = {
  sendRequest: (method: string, params?: unknown) => Promise<unknown>;
  writeLine: (payload: unknown) => void;
  onNotification: (method: string, params: unknown) => void;
  onServerRequest: (request: { id: string | number; method: string; params: unknown }) => void;
};

function internals(session: CodexSession): SessionInternals {
  return session as unknown as SessionInternals;
}

describe("CodexSession app-server contract", () => {
  test("publishes viewed images only on successful item completion", () => {
    const session = new CodexSession();
    session.threadId = "thread-1";
    session.activeTurnId = "turn-1";
    const events: BridgeEvent[] = [];
    session.eventBus.subscribe((event) => events.push(event), { replay: false });
    const params = { threadId: "thread-1", turnId: "turn-1", item: { type: "imageView", id: "exec-screenshot", path: "/tmp/desktop-conversation.png" } };
    const images = () => events.flatMap((event) => event.type === "item.completed" && event.payload.item.type === "image" ? [event.payload] : []);
    internals(session).onNotification("item/started", params);
    // Until the image exists, viewing it is an activity.
    expect(events.at(-1)?.payload).toMatchObject({ item: { type: "activity", status: "started", activity: { kind: "image", action: "view" } } });
    expect(images()).toEqual([]);
    internals(session).onNotification("item/completed", params);
    expect(images()).toEqual([
      { turnId: "turn-1", item: { id: params.item.id, type: "image", image: { itemId: params.item.id, turnId: "turn-1", path: params.item.path, kind: "viewed" } } },
    ]);
    internals(session).onNotification("item/completed", { ...params, item: { ...params.item, status: "failed" } });
    expect(images()).toHaveLength(1);
  });
  test("uses the generated initialize and initialized envelope shapes", async () => {
    const fake = fakeAppServer();
    const session = new CodexSession(undefined, undefined, fake.server);

    await session.initialize();

    expect(fake.received()).toEqual([
      {
        id: 1,
        method: "initialize",
        params: {
          capabilities: { experimentalApi: true },
          clientInfo: { name: "shepherd", title: "Shepherd", version: "1.0.0" },
        },
      },
      { method: "initialized" },
    ]);
    session.stop(); fake.server.stop();
  });

  test("reverts with an explicit cutoff and decodes provider history replacement", async () => {
    const session = new CodexSession();
    session.initialize = async () => {};
    const requests: unknown[] = [];
    internals(session).sendRequest = async (method, params) => { requests.push({ method, params }); return { thread: { id: "thread-1", turns: [] }, turnsBackwardsCursor: "turn-cursor", itemsBackwardsCursor: "item-cursor" }; };
    const response = await session.revertThread("thread-1", "turn-2");
    expect(requests).toEqual([{ method: "thread/revert", params: { threadId: "thread-1", beforeTurnId: "turn-2" } }]);
    expect(response).toMatchObject({ turnsBackwardsCursor: "turn-cursor", itemsBackwardsCursor: "item-cursor" });
    const events: BridgeEvent[] = [];
    session.eventBus.subscribe((event) => events.push(event), { replay: false });
    internals(session).onNotification("thread/reverted", { threadId: "thread-1" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "thread.reverted", threadId: "thread-1", payload: {} });
  });

  test("defaults new threads to Sol medium while preserving explicit overrides", async () => {
    const previousModel = process.env.CODEX_MODEL;
    delete process.env.CODEX_MODEL;
    try {
      const session = new CodexSession();
      const requests: unknown[] = [];
      session.initialize = async () => {};
      internals(session).sendRequest = async (_method, params) => {
        requests.push(params);
        return { thread: { id: "thread-defaults", cwd: "/repo" } };
      };
      await session.startThread({});
      await session.startThread({ model: "custom-model", effort: "high" });
      expect(requests[0]).toMatchObject({ model: "gpt-6.1-sol", config: { model_reasoning_effort: "medium" } });
      expect(requests[1]).toMatchObject({ model: "custom-model", config: { model_reasoning_effort: "high" } });
      process.env.CODEX_MODEL = "environment-model";
      await session.startThread({});
      expect(requests[2]).toMatchObject({ model: "environment-model" });
    } finally {
      if (previousModel === undefined) delete process.env.CODEX_MODEL;
      else process.env.CODEX_MODEL = previousModel;
    }
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
    const session = new CodexSession(tools);
    const requests: Array<{ method: string; params: unknown }> = [];
    session.initialize = async () => {};
    internals(session).sendRequest = async (method, params) => {
      requests.push({ method, params });
      return { thread: { id: "thread-1", cwd: "/repo", modelProvider: "openai" } };
    };

    await session.startThread({ cwd: "/workspace" });

    expect(requests[0]?.method).toBe("thread/start");
    // Codex's configured instructions stay in effect: Shepherd sends neither instruction field.
    expect(requests[0]?.params).not.toHaveProperty("baseInstructions");
    expect(requests[0]?.params).not.toHaveProperty("developerInstructions");
    expect(requests[0]?.params).not.toHaveProperty("ephemeral");
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
        return { success: true, contentItems: [{ type: "text", text: "ready" }] };
      },
    });
    const session = new CodexSession(tools);
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

  test("reset redemption initializes the session and preserves retry identity", async () => {
    const session = new CodexSession();
    let initialized = false;
    session.initialize = async () => { initialized = true; };
    const requests: unknown[] = [];
    internals(session).sendRequest = async (method, params) => {
      expect(initialized).toBe(true);
      requests.push({ method, params });
      return { outcome: requests.length === 1 ? "reset" : "alreadyRedeemed" };
    };
    const request = { idempotencyKey: "attempt-1", creditId: "credit-1" };
    await expect(session.consumeRateLimitReset(request)).resolves.toEqual({ outcome: "reset" });
    await expect(session.consumeRateLimitReset(request)).resolves.toEqual({ outcome: "alreadyRedeemed" });
    expect(requests).toEqual([1, 2].map(() => ({ method: "account/rateLimitResetCredit/consume", params: request })));
  });

  test("omits params for parameterless requests and removed skill-list fields", async () => {
    const session = new CodexSession();
    const requests: Array<{ method: string; params: unknown }> = [];
    const raw = internals(session);
    session.initialize = async () => {};
    raw.sendRequest = async (method, params) => {
      requests.push({ method, params });
      return method === "skills/list" ? { data: [] } : {};
    };

    await session.readAccountRateLimits();
    await session.listSkills({ workspacePath: "/workspace", refresh: true });

    expect(requests).toEqual([
      { method: "account/rateLimits/read", params: undefined },
      { method: "skills/list", params: { cwds: ["/workspace"], forceReload: true } },
    ]);
  });

  test("keeps native granular settings private when resuming provider defaults", async () => {
    const session = new CodexSession();
    session.initialize = async () => {};
    internals(session).sendRequest = async () => ({
      thread: { id: "thread-1", cwd: "/repo", modelProvider: "openai" },
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

    // Settings no profile describes are reported as no profile, never as a guessed one.
    expect(await session.resumeThread("thread-1", { profile: "danger-full-access:never" })).toMatchObject({ profile: null });
    expect(session.profile).toBeNull();
  });

  test("Codex profiles send their sandbox and approval, and are read back only when Codex confirms them", async () => {
    const session = new CodexSession();
    session.initialize = async () => {};
    const requests: Array<{ method: string; params: any }> = [];
    let response: Record<string, unknown> = {};
    internals(session).sendRequest = async (method, params) => { requests.push({ method, params }); return { thread: { id: "thread-1", cwd: "/repo" }, ...response }; };
    response = { approvalPolicy: "on-request", sandbox: { type: "workspaceWrite", networkAccess: false, writableRoots: [] } };
    expect(await session.startThread({ profile: "workspace-write:on-request" })).toMatchObject({ profile: "workspace-write:on-request" });
    expect(requests.at(-1)!.params).toMatchObject({ sandbox: "workspace-write", approvalPolicy: "on-request" });
    // A workspace sandbox with network access is looser than any workspace profile.
    response = { approvalPolicy: "on-request", sandbox: { type: "workspaceWrite", networkAccess: true, writableRoots: [] } };
    expect(await session.resumeThread("thread-1", { profile: "workspace-write:on-request" })).toMatchObject({ profile: null });
    // Without a profile, Codex's own configuration applies and nothing is sent.
    response = {};
    expect(await session.forkThread("thread-1", {})).toMatchObject({ profile: null });
    expect(requests.at(-1)!.params).not.toHaveProperty("sandbox");
    expect(requests.at(-1)!.params).not.toHaveProperty("approvalPolicy");
  });

  test("returns a JSON-RPC error for unsupported server requests", () => {
    const session = new CodexSession();
    const writes: unknown[] = [];
    const events: BridgeEvent[] = [];
    internals(session).writeLine = (payload) => writes.push(payload);
    session.eventBus.subscribe((event) => events.push(event), { replay: false });

    internals(session).onServerRequest({
      id: 7,
      method: "unsupported/request",
      params: {},
    });

    expect(writes).toEqual([
      {
        id: 7,
        error: {
          code: -32601,
          message: "Shepherd does not support server request unsupported/request.",
        },
      },
    ]);
    expect(events.at(-1)?.type).toBe("session.error");
  });

  test("maps legacy denial to the generated structured decision", async () => {
    const session = new CodexSession();
    session.threadId = "thread-1";
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
      decision: (requested!.payload as import("../shared/protocol/approvals").ApprovalRequestPayload).choices.find(choice => choice.intent === "deny")!.value,
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
    const session = new CodexSession();
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
        { message: "The context window was exceeded." },
      ],
      [
        "turn.failed",
        "thread-schema",
        { message: "Provider rejected the request.", turnId: "turn-active" },
      ],
    ]);
    expect(session.activeTurnId).toBeNull();
  });

  test("keeps retry diagnostics out of the user-visible event stream", async () => {
    const fake = fakeAppServer();
    const session = new CodexSession(undefined, undefined, fake.server);
    await session.initialize();
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
    await fake.stderr("Reconnecting... 3/5");

    expect(events).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith("codex app-server retrying: Reconnecting... 2/5");
    expect(error).toHaveBeenCalledWith("codex app-server stderr: Reconnecting... 3/5");

    session.stop(); fake.server.stop();
    warn.mockRestore();
    error.mockRestore();
  });

  test("publishes an exhausted retry as one session error", () => {
    const session = new CodexSession();
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
    const session = new CodexSession();
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

    // Live items are the records history returns for the same native items.
    expect(events.map((event) => [event.type, event.payload])).toEqual([
      ["item.started", { turnId: "turn-1", item: { id: "command-1", type: "activity", status: "started", activity: { kind: "command", command: "bun test", cwd: null } } }],
      ["item.completed", { turnId: "turn-1", item: { id: "image-1", type: "image", image: { itemId: "image-1", turnId: "turn-1", path: "/tmp/generated-unicorn.png", prompt: "A pastel unicorn", kind: "generated" } } }],
      ["item.completed", { turnId: "turn-1", item: { id: "final-1", type: "assistant_message", text: "Complete answer", phase: "final" } }],
    ]);
  });

  test("streams plan, reasoning summary and command output deltas on their own channels", () => {
    const session = new CodexSession();
    const events: BridgeEvent[] = [];
    session.threadId = "thread-1";
    session.activeTurnId = "turn-1";
    session.eventBus.subscribe((event) => events.push(event), { replay: false });
    for (const [method, itemId] of [["item/plan/delta", "plan-1"], ["item/reasoning/summaryTextDelta", "reason-1"], ["item/commandExecution/outputDelta", "command-1"], ["item/reasoning/textDelta", "reason-1"]] as const) {
      internals(session).onNotification(method, { threadId: "thread-1", turnId: "turn-1", itemId, delta: "text" });
    }
    // Raw reasoning text stays private; summaries are what history keeps.
    expect(events.map((event) => event.type === "item.delta" ? [event.payload.channel, event.payload.itemId] : event.type)).toEqual([
      ["plan", "plan-1"], ["reasoning", "reason-1"], ["output", "command-1"],
    ]);
    // A reasoning delta names the summary part it extends.
    internals(session).onNotification("item/reasoning/summaryTextDelta", { threadId: "thread-1", turnId: "turn-1", itemId: "reason-1", delta: "second", summaryIndex: 1 });
    expect(events.at(-1)?.payload).toMatchObject({ channel: "reasoning", delta: "second", part: 1 });
  });

  test("attaches turn and captured phase metadata to agent deltas", () => {
    const session = new CodexSession();
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

    expect(events.find((event) => event.type === "item.delta")?.payload).toEqual({
      turnId: "turn-1",
      itemId: "comment-1",
      channel: "message",
      delta: "Checking now.",
      phase: "interim",
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
