import { describe, expect, test } from "bun:test";

import {
  handleCreateSurfaceThread,
  handleSetSurfaceWorkspaceTarget,
  handleSubmitSurfaceTurn,
} from "../server/adapters/http/routes/surfaces.js";
import { handleGetThreadModel, handleSetThreadModel } from "../server/adapters/http/routes/models.js";

function makeConversation() {
  const calls: Record<string, unknown[]> = {
    setSurfaceWorkspaceTarget: [],
    createSurfaceThreadFromContext: [],
    submitSurfaceTurn: [],
    setThreadModelFromRequest: [],
  };

  const conversation = {
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
