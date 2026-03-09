import { describe, expect, test } from "bun:test";

import { ConversationService } from "../server/core/conversation_service.js";

function makeWorkflowHarness() {
  const calls: Record<string, unknown[]> = {
    createThread: [],
    resumeThread: [],
    forkThread: [],
    bindSurfaceToThread: [],
    submitTurn: [],
    steerTurn: [],
  };

  const surfaceThreads = new Map<string, string | null>();
  const attachedThreads = new Map<string, string[]>();
  const workspaceTargets = new Map<string, unknown>();

  const manager = {
    async createThread(request: unknown) {
      calls.createThread.push(request);
      return { threadId: "thread-created", sessionId: "session-created" };
    },
    async resumeThread(threadId: string, request: unknown) {
      calls.resumeThread.push({ threadId, request });
      return { threadId: `${threadId}-resumed`, sessionId: "session-resumed" };
    },
    async forkThread(threadId: string, request: unknown) {
      calls.forkThread.push({ threadId, request });
      return { threadId: `${threadId}-forked`, sessionId: "session-forked" };
    },
    getThreadState(threadId: string) {
      if (threadId === "thread-active") {
        return {
          threadId,
          sessionId: "session-active",
          activeTurnId: "turn-active",
          approvalPolicy: "on-request" as const,
        };
      }
      return {
        threadId,
        sessionId: "session-id",
        activeTurnId: null,
        approvalPolicy: "on-request" as const,
      };
    },
    async submitTurn(threadId: string, request: unknown) {
      calls.submitTurn.push({ threadId, request });
      return { ok: true, turnId: "turn-submitted" };
    },
    async steerTurn(threadId: string, request: unknown) {
      calls.steerTurn.push({ threadId, request });
      return { ok: true, turnId: "turn-steered" };
    },
    subscribeToThreadEvents() {
      return () => undefined;
    },
  };

  const routing = {
    getDefaultThread(adapter: string, surfaceId: string) {
      return surfaceThreads.get(`${adapter}:${surfaceId}`) ?? null;
    },
    getAttachedThreads(adapter: string, surfaceId: string) {
      return attachedThreads.get(`${adapter}:${surfaceId}`) ?? [];
    },
    async setDefaultThread(adapter: string, surfaceId: string, threadId: string) {
      surfaceThreads.set(`${adapter}:${surfaceId}`, threadId);
      const current = attachedThreads.get(`${adapter}:${surfaceId}`) ?? [];
      attachedThreads.set(`${adapter}:${surfaceId}`, [...new Set([...current, threadId])]);
      calls.bindSurfaceToThread.push({ adapter, surfaceId, threadId });
      return threadId;
    },
    clearDefaultThread(adapter: string, surfaceId: string) {
      surfaceThreads.set(`${adapter}:${surfaceId}`, null);
    },
    async resolveRoute() {
      return { threadId: "thread-created", created: true, resumed: false, reason: "auto-created" as const };
    },
  };

  const workspaces = {
    getSurfaceTarget(adapter: string, surfaceId: string) {
      return (workspaceTargets.get(`${adapter}:${surfaceId}`) as unknown) ?? null;
    },
    setSurfaceTarget(adapter: string, surfaceId: string, target: unknown) {
      workspaceTargets.set(`${adapter}:${surfaceId}`, target);
    },
    async materializeSurfaceWorkspace() {
      return {
        workspaceId: "workspace-1",
        cwd: "/tmp/workspace-1",
        target: { kind: "local", rootPath: "/tmp", display: "~/tmp", appendWorkspaceId: true },
      };
    },
    applyCwdToCreateRequest(request: Record<string, unknown>, cwd: string) {
      return { ...request, cwd };
    },
    applyCwdToResumeRequest(request: Record<string, unknown>, cwd: string) {
      return { ...request, cwd };
    },
    applyCwdToForkRequest(request: Record<string, unknown>, cwd: string) {
      return { ...request, cwd };
    },
  };

  const service = new ConversationService() as unknown as ConversationService & {
    manager: typeof manager;
    routing: typeof routing;
    workspaces: typeof workspaces;
  };

  service.manager = manager;
  service.routing = routing;
  service.workspaces = workspaces;

  return { service, calls };
}

describe("ConversationService surface workflow", () => {
  test("createSurfaceThreadFromContext materializes workspace and binds created thread", async () => {
    const { service, calls } = makeWorkflowHarness();

    service.setSurfaceWorkspaceTarget("discord", "chan-1", {
      kind: "local",
      rootPath: "/tmp",
      display: "~/tmp",
      appendWorkspaceId: true,
    });

    const created = await service.createSurfaceThreadFromContext("discord", "chan-1", {
      approvalPolicy: "on-request",
    });

    expect(created.threadId).toBe("thread-created");
    expect(calls.createThread).toEqual([{ approvalPolicy: "on-request", cwd: "/tmp/workspace-1" }]);
    expect(calls.bindSurfaceToThread).toEqual([
      { adapter: "discord", surfaceId: "chan-1", threadId: "thread-created" },
    ]);
  });

  test("resumeSurfaceThreadFromContext uses materialized cwd and rebinds the surface", async () => {
    const { service, calls } = makeWorkflowHarness();

    service.setSurfaceWorkspaceTarget("discord", "chan-1", {
      kind: "local",
      rootPath: "/tmp",
      display: "~/tmp",
      appendWorkspaceId: true,
    });

    const resumed = await service.resumeSurfaceThreadFromContext("discord", "chan-1", "thread-1", {});

    expect(resumed.threadId).toBe("thread-1-resumed");
    expect(calls.resumeThread).toEqual([
      { threadId: "thread-1", request: { cwd: "/tmp/workspace-1" } },
    ]);
    expect(calls.bindSurfaceToThread).toEqual([
      { adapter: "discord", surfaceId: "chan-1", threadId: "thread-1-resumed" },
    ]);
  });

  test("submitSurfaceTurn auto-creates and submits when no bound thread exists", async () => {
    const { service, calls } = makeWorkflowHarness();

    service.setSurfaceWorkspaceTarget("http", "surface-1", {
      kind: "local",
      rootPath: "/tmp",
      display: "~/tmp",
      appendWorkspaceId: true,
    });

    const result = await service.submitSurfaceTurn("http", "surface-1", {
      input: "hello",
      approvalPolicy: "on-request",
    });

    expect(result).toEqual({
      threadId: "thread-created",
      action: "submitted",
      turnId: "turn-submitted",
    });
    expect(calls.submitTurn).toEqual([
      { threadId: "thread-created", request: { input: "hello", approvalPolicy: "on-request", model: undefined } },
    ]);
  });

  test("submitSurfaceTurn steers when active turn exists and policy requests it", async () => {
    const { service, calls } = makeWorkflowHarness();

    await service.bindSurfaceToThread("discord", "chan-1", "thread-active");
    const result = await service.submitSurfaceTurn("discord", "chan-1", {
      input: "keep going",
      autoSteerActiveTurn: true,
    });

    expect(result).toEqual({
      threadId: "thread-active",
      action: "steered",
      turnId: "turn-steered",
    });
    expect(calls.steerTurn).toEqual([
      { threadId: "thread-active", request: { input: "keep going", turnId: "turn-active" } },
    ]);
  });

  test("submitSurfaceTurn honors autoCreateIfMissing=false", async () => {
    const { service } = makeWorkflowHarness();

    await expect(
      service.submitSurfaceTurn("http", "surface-1", {
        input: "hello",
        autoCreateIfMissing: false,
      }),
    ).rejects.toThrow("No routing target available for this surface.");
  });

  test("submitSurfaceTurn resumes an explicit unloaded thread from surface context", async () => {
    const { service, calls } = makeWorkflowHarness();

    service.setSurfaceWorkspaceTarget("http", "surface-1", {
      kind: "local",
      rootPath: "/tmp",
      display: "~/tmp",
      appendWorkspaceId: true,
    });

    let firstBind = true;
    service.bindSurfaceToThread = (async () => {
      if (firstBind) {
        firstBind = false;
        throw new Error("Thread thread-explicit is not loaded. Resume it with an explicit cwd before binding.");
      }
      return "thread-explicit-resumed";
    }) as typeof service.bindSurfaceToThread;

    const result = await service.submitSurfaceTurn("http", "surface-1", {
      input: "hello",
      explicitThreadId: "thread-explicit",
      approvalPolicy: "on-request",
    });

    expect(result).toEqual({
      threadId: "thread-explicit-resumed",
      action: "submitted",
      turnId: "turn-submitted",
    });
    expect(calls.resumeThread).toEqual([
      { threadId: "thread-explicit", request: { approvalPolicy: "on-request", sandbox: undefined, cwd: "/tmp/workspace-1" } },
    ]);
  });
});
