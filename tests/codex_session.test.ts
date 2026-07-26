import { describe, expect, test } from "bun:test";

import type { BridgeEvent } from "../shared/protocol/events.js";
import { CodexSession } from "../server/core/codex_session.js";
import { extractThreadSummary } from "../server/core/session_manager.js";

type SessionInternals = {
  start: () => Promise<void>;
  sendRequest: (method: string, params?: unknown) => Promise<unknown>;
  sendNotification: (method: string) => void;
  writeLine: (payload: unknown) => void;
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
          capabilities: {},
          clientInfo: { name: "shepherd", title: "Shepherd", version: "1.0.0" },
        },
      },
    ]);
    expect(notifications).toEqual(["initialized"]);
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
        { message: "Provider rejected the request." },
      ],
    ]);
    expect(session.activeTurnId).toBeNull();
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
