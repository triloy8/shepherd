import { describe, expect, test } from "bun:test";

import {
  handleBindSurfaceThread,
  handleClearSurfaceThread,
  handleClearSurfaceWorkspaceTarget,
  handleCreateSurfaceThread,
  handleGetSurfaceContext,
  handleGetSurfaceModel,
  handleGetSurfaceWorkspaceTarget,
  handleInterruptSurfaceTurn,
  handleSetSurfaceWorkspaceTarget,
  handleSetSurfaceModel,
  handleSubmitSurfaceTurn,
} from "../server/adapters/http/routes/surfaces.js";
import { handleGetThreadModel, handleSetThreadModel } from "../server/adapters/http/routes/models.js";

function makeConversation() {
  const calls: Record<string, unknown[]> = {
    bindSurfaceToThread: [],
    clearSurfaceBinding: [],
    clearSurfaceWorkspaceTarget: [],
    setSurfaceWorkspaceTarget: [],
    createSurfaceThreadFromContext: [],
    interruptSurfaceTurn: [],
    submitSurfaceTurn: [],
    setSurfaceModel: [],
    setThreadModelFromRequest: [],
  };

  const conversation = {
    getSurfaceState(adapter: string, surfaceId: string) {
      return {
        adapter,
        surfaceId,
        activeThreadId: "thread-1",
        attachedThreadIds: ["thread-1"],
        workspaceTarget: {
          kind: "local",
          rootPath: "/tmp",
          display: "~/tmp",
          appendWorkspaceId: true,
        },
      };
    },
    getSurfaceWorkspaceTarget() {
      return {
        kind: "local",
        rootPath: "/tmp",
        display: "~/tmp",
        appendWorkspaceId: true,
      };
    },
    async bindSurfaceToThread(adapter: string, surfaceId: string, threadId: string) {
      calls.bindSurfaceToThread.push({ adapter, surfaceId, threadId });
      return threadId;
    },
    clearSurfaceBinding(adapter: string, surfaceId: string) {
      calls.clearSurfaceBinding.push({ adapter, surfaceId });
    },
    clearSurfaceWorkspaceTarget(adapter: string, surfaceId: string) {
      calls.clearSurfaceWorkspaceTarget.push({ adapter, surfaceId });
    },
    setSurfaceWorkspaceTarget(adapter: string, surfaceId: string, target: unknown) {
      calls.setSurfaceWorkspaceTarget.push({ adapter, surfaceId, target });
      return target;
    },
    async createSurfaceThreadFromContext(adapter: string, surfaceId: string, request: unknown) {
      calls.createSurfaceThreadFromContext.push({ adapter, surfaceId, request });
      return { threadId: "thread-1", sessionId: "session-1" };
    },
    async submitSurfaceTurn(adapter: string, surfaceId: string, request: unknown) {
      calls.submitSurfaceTurn.push({ adapter, surfaceId, request });
      return { threadId: "thread-1", action: "submitted", turnId: "turn-1" };
    },
    async getSurfaceContext() {
      return {
        threadId: "thread-1",
        tokenUsage: null,
      };
    },
    async readThreadTokenUsage() {
      return {
        threadId: "thread-1",
        tokenUsage: null,
      };
    },
    getSurfaceModel() {
      return { threadId: "thread-1", currentModel: "o4-mini", modelProvider: "openai", pendingModel: null };
    },
    setSurfaceModel(adapter: string, surfaceId: string, request: unknown) {
      calls.setSurfaceModel.push({ adapter, surfaceId, request });
      return { threadId: "thread-1", currentModel: "o4-mini", modelProvider: "openai", pendingModel: "gpt-5.3-codex" };
    },
    async interruptSurfaceTurn(adapter: string, surfaceId: string, turnId?: string) {
      calls.interruptSurfaceTurn.push({ adapter, surfaceId, turnId });
    },
    getThreadModel(threadId: string) {
      return { threadId, currentModel: "o4-mini", modelProvider: "openai", pendingModel: null };
    },
    setThreadModelFromRequest(threadId: string, request: unknown) {
      calls.setThreadModelFromRequest.push({ threadId, request });
      return { threadId, currentModel: "o4-mini", modelProvider: "openai", pendingModel: "gpt-5.3-codex" };
    },
  };

  return { conversation, calls };
}

async function asJson(response: Response) {
  return response.json();
}

describe("HTTP surface routes", () => {
  test("set workspace target delegates to conversation service", async () => {
    const { conversation, calls } = makeConversation();
    const response = await handleSetSurfaceWorkspaceTarget(
      new Request("http://example.test", {
        method: "POST",
        body: JSON.stringify({
          target: {
            kind: "local",
            rootPath: "/tmp",
            display: "~/tmp",
            appendWorkspaceId: true,
          },
        }),
      }),
      conversation as never,
      "discord",
      "chan-1",
    );

    expect(response.status).toBe(200);
    expect(await asJson(response)).toEqual({
      target: {
        kind: "local",
        rootPath: "/tmp",
        display: "~/tmp",
        appendWorkspaceId: true,
      },
    });
    expect(calls.setSurfaceWorkspaceTarget).toEqual([
      {
        adapter: "discord",
        surfaceId: "chan-1",
        target: {
          kind: "local",
          rootPath: "/tmp",
          display: "~/tmp",
          appendWorkspaceId: true,
        },
      },
    ]);
  });

  test("get workspace target returns the current surface target", async () => {
    const { conversation } = makeConversation();
    const response = handleGetSurfaceWorkspaceTarget(conversation as never, "discord", "chan-1");

    expect(response.status).toBe(200);
    expect(await asJson(response)).toEqual({
      target: {
        kind: "local",
        rootPath: "/tmp",
        display: "~/tmp",
        appendWorkspaceId: true,
      },
    });
  });

  test("clear workspace target delegates to conversation service", async () => {
    const { conversation, calls } = makeConversation();
    const response = handleClearSurfaceWorkspaceTarget(conversation as never, "discord", "chan-1");

    expect(response.status).toBe(200);
    expect(await asJson(response)).toEqual({ ok: true });
    expect(calls.clearSurfaceWorkspaceTarget).toEqual([{ adapter: "discord", surfaceId: "chan-1" }]);
  });

  test("bind surface thread delegates to conversation service", async () => {
    const { conversation, calls } = makeConversation();
    const response = await handleBindSurfaceThread(
      new Request("http://example.test", {
        method: "POST",
        body: JSON.stringify({ threadId: "thread-9" }),
      }),
      conversation as never,
      "http",
      "surface-1",
    );

    expect(response.status).toBe(200);
    expect(await asJson(response)).toEqual({ threadId: "thread-9" });
    expect(calls.bindSurfaceToThread).toEqual([
      { adapter: "http", surfaceId: "surface-1", threadId: "thread-9" },
    ]);
  });

  test("clear surface thread delegates to conversation service", async () => {
    const { conversation, calls } = makeConversation();
    const response = handleClearSurfaceThread(conversation as never, "http", "surface-1");

    expect(response.status).toBe(200);
    expect(await asJson(response)).toEqual({ ok: true });
    expect(calls.clearSurfaceBinding).toEqual([{ adapter: "http", surfaceId: "surface-1" }]);
  });

  test("create surface thread route passes validated payload to core", async () => {
    const { conversation, calls } = makeConversation();
    const response = await handleCreateSurfaceThread(
      new Request("http://example.test", {
        method: "POST",
        body: JSON.stringify({ approvalPolicy: "on-request", sandbox: "workspace-write" }),
      }),
      conversation as never,
      "http",
      "surface-1",
    );

    expect(response.status).toBe(200);
    expect(await asJson(response)).toEqual({ threadId: "thread-1", sessionId: "session-1" });
    expect(calls.createSurfaceThreadFromContext).toEqual([
      {
        adapter: "http",
        surfaceId: "surface-1",
        request: { approvalPolicy: "on-request", sandbox: "workspace-write" },
      },
    ]);
  });

  test("submit surface turn route supports auto-steer fields", async () => {
    const { conversation, calls } = makeConversation();
    const response = await handleSubmitSurfaceTurn(
      new Request("http://example.test", {
        method: "POST",
        body: JSON.stringify({
          input: "hello",
          explicitThreadId: "thread-1",
          autoSteerActiveTurn: true,
        }),
      }),
      conversation as never,
      "http",
      "surface-1",
    );

    expect(response.status).toBe(200);
    expect(await asJson(response)).toEqual({
      threadId: "thread-1",
      action: "submitted",
      turnId: "turn-1",
    });
    expect(calls.submitSurfaceTurn).toEqual([
      {
        adapter: "http",
        surfaceId: "surface-1",
        request: {
          input: "hello",
          approvalPolicy: undefined,
          model: undefined,
          explicitThreadId: "thread-1",
          autoCreateIfMissing: undefined,
          autoSteerActiveTurn: true,
          sandbox: undefined,
        },
      },
    ]);
  });

  test("get surface context proxies the active thread context", async () => {
    const { conversation } = makeConversation();
    const response = await handleGetSurfaceContext(conversation as never, "http", "surface-1");

    expect(response.status).toBe(200);
    expect(await asJson(response)).toEqual({
      threadId: "thread-1",
      baselineTokens: 12000,
      modelContextWindow: null,
      contextLeftPercent: null,
      effectiveRemainingTokens: null,
      currentContextUsage: null,
      lifetimeCumulativeUsage: null,
      tokenUsage: null,
    });
  });

  test("get and set surface model use the active surface thread", async () => {
    const { conversation, calls } = makeConversation();
    const getResponse = handleGetSurfaceModel(conversation as never, "http", "surface-1");
    const setResponse = await handleSetSurfaceModel(
      new Request("http://example.test", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-5.3-codex" }),
      }),
      conversation as never,
      "http",
      "surface-1",
    );

    expect(getResponse.status).toBe(200);
    expect(await asJson(getResponse)).toEqual({
      threadId: "thread-1",
      currentModel: "o4-mini",
      modelProvider: "openai",
      pendingModel: null,
    });
    expect(setResponse.status).toBe(200);
    expect(await asJson(setResponse)).toEqual({
      threadId: "thread-1",
      currentModel: "o4-mini",
      modelProvider: "openai",
      pendingModel: "gpt-5.3-codex",
    });
    expect(calls.setSurfaceModel).toEqual([
      { adapter: "http", surfaceId: "surface-1", request: { model: "gpt-5.3-codex" } },
    ]);
  });

  test("interrupt surface turn delegates to the active surface thread", async () => {
    const { conversation, calls } = makeConversation();
    const response = await handleInterruptSurfaceTurn(
      new Request("http://example.test", {
        method: "POST",
        body: JSON.stringify({ turnId: "turn-9" }),
      }),
      conversation as never,
      "http",
      "surface-1",
    );

    expect(response.status).toBe(200);
    expect(await asJson(response)).toEqual({ ok: true });
    expect(calls.interruptSurfaceTurn).toEqual([
      { adapter: "http", surfaceId: "surface-1", turnId: "turn-9" },
    ]);
  });
});

describe("HTTP model routes", () => {
  test("get thread model returns the current model state", async () => {
    const { conversation } = makeConversation();
    const response = handleGetThreadModel(conversation as never, "thread-1");

    expect(response.status).toBe(200);
    expect(await asJson(response)).toEqual({
      threadId: "thread-1",
      currentModel: "o4-mini",
      modelProvider: "openai",
      pendingModel: null,
    });
  });

  test("set thread model validates and forwards the request", async () => {
    const { conversation, calls } = makeConversation();
    const response = await handleSetThreadModel(
      new Request("http://example.test", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-5.3-codex" }),
      }),
      conversation as never,
      "thread-1",
    );

    expect(response.status).toBe(200);
    expect(await asJson(response)).toEqual({
      threadId: "thread-1",
      currentModel: "o4-mini",
      modelProvider: "openai",
      pendingModel: "gpt-5.3-codex",
    });
    expect(calls.setThreadModelFromRequest).toEqual([
      { threadId: "thread-1", request: { model: "gpt-5.3-codex" } },
    ]);
  });
});
