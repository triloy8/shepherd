import { describe, expect, test } from "bun:test";

import type { BridgeEvent } from "../shared/protocol/events.js";
import { SurfaceConversationOrchestrator } from "../server/core/surface_conversation_orchestrator.js";
import { SurfaceStateService } from "../server/core/surface_state_service.js";
import { WorkspaceProvisioner } from "../server/core/workspace_provisioner.js";

function makeHarness() {
  const calls = {
    createSurfaceThread: [] as Array<{ adapter: string; surfaceId: string; request: Record<string, unknown> }>,
    resumeThread: [] as Array<{ threadId: string; request: Record<string, unknown> }>,
    forkThread: [] as Array<{ threadId: string; request: Record<string, unknown> }>,
    setThreadCwd: [] as Array<{ threadId: string; cwd: string }>,
    provisionWorkspace: [] as Array<{ threadId: string }>,
    bindSurfaceToThread: [] as Array<{ adapter: string; surfaceId: string; threadId: string }>,
    subscribeSurfaceEvents: [] as Array<{ adapter: string; surfaceId: string }>,
    clearSurfaceBinding: [] as Array<{ adapter: string; surfaceId: string }>,
    unsubscribeSurfaceEvents: [] as Array<{ adapter: string; surfaceId: string }>,
  };

  const surfaceThreads = new Map<string, string | null>();
  const conversation = {
    getSurfaceThread(adapter: string, surfaceId: string) {
      return surfaceThreads.get(`${adapter}:${surfaceId}`) ?? null;
    },
    async createSurfaceThread(adapter: string, surfaceId: string, request: Record<string, unknown>) {
      calls.createSurfaceThread.push({ adapter, surfaceId, request });
      surfaceThreads.set(`${adapter}:${surfaceId}`, "thread-created");
      return { threadId: "thread-created", sessionId: "session-1" };
    },
    async resumeThread(threadId: string, request: Record<string, unknown>) {
      calls.resumeThread.push({ threadId, request });
      return { threadId, sessionId: "session-2" };
    },
    async forkThread(threadId: string, request: Record<string, unknown>) {
      calls.forkThread.push({ threadId, request });
      return { threadId: "thread-forked", sessionId: "session-3" };
    },
    async bindSurfaceToThread(adapter: string, surfaceId: string, threadId: string) {
      calls.bindSurfaceToThread.push({ adapter, surfaceId, threadId });
      surfaceThreads.set(`${adapter}:${surfaceId}`, threadId);
      return threadId;
    },
    setThreadCwd(threadId: string, cwd: string) {
      calls.setThreadCwd.push({ threadId, cwd });
    },
    getThreadState(threadId: string) {
      if (threadId === "thread-missing") {
        throw new Error("missing");
      }
      return { threadId };
    },
    subscribeSurfaceEvents(adapter: string, surfaceId: string, _listener: (event: BridgeEvent) => void) {
      calls.subscribeSurfaceEvents.push({ adapter, surfaceId });
      return () => undefined;
    },
    clearSurfaceBinding(adapter: string, surfaceId: string) {
      calls.clearSurfaceBinding.push({ adapter, surfaceId });
    },
    unsubscribeSurfaceEvents(adapter: string, surfaceId: string) {
      calls.unsubscribeSurfaceEvents.push({ adapter, surfaceId });
    },
  };

  const surfaceState = new SurfaceStateService();
  const workspaceProvisioner = {
    async provisionWorkspace(_target: unknown, threadId: string) {
      calls.provisionWorkspace.push({ threadId });
      return { workspaceId: threadId, cwd: `/tmp/${threadId}` };
    },
  } as unknown as WorkspaceProvisioner;

  const orchestrator = new SurfaceConversationOrchestrator(
    conversation as never,
    surfaceState,
    workspaceProvisioner,
    { adapter: "discord", approvalPolicy: "on-request", sandbox: "workspace-write" },
  );

  return { orchestrator, surfaceState, calls };
}

describe("SurfaceConversationOrchestrator", () => {
  test("stores and reports surface project bindings", async () => {
    const { orchestrator } = makeHarness();
    const result = await orchestrator.setSurfaceProject("chan-1", "~");

    expect(result).toEqual({ repoSlug: "~" });
    expect(orchestrator.getSurfaceProjectDisplay("chan-1")).toBe("~");
  });

  test("creates a surface thread before provisioning its thread-id workspace", async () => {
    const { orchestrator, calls } = makeHarness();
    await orchestrator.setSurfaceProject("chan-1", "~");

    const threadId = await orchestrator.createAndBindSurfaceThread("chan-1", () => undefined);

    expect(threadId).toBe("thread-created");
    expect(calls.createSurfaceThread).toHaveLength(1);
    expect(calls.createSurfaceThread[0]?.request).toEqual({
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    expect(calls.provisionWorkspace).toEqual([{ threadId: "thread-created" }]);
    expect(calls.setThreadCwd).toEqual([{ threadId: "thread-created", cwd: "/tmp/thread-created" }]);
    expect(calls.subscribeSurfaceEvents).toHaveLength(1);
  });

  test("resumes and forks threads through the shared orchestration path", async () => {
    const { orchestrator, calls } = makeHarness();
    await orchestrator.setSurfaceProject("chan-1", "~");

    const resumed = await orchestrator.resumeSurfaceThread("chan-1", "thread-a", () => undefined);
    const forked = await orchestrator.forkSurfaceThread("chan-1", "thread-a", () => undefined);

    expect(resumed).toBe("thread-a");
    expect(forked).toBe("thread-forked");
    expect(calls.resumeThread).toHaveLength(1);
    expect(calls.forkThread).toHaveLength(1);
    expect(calls.provisionWorkspace).toEqual([{ threadId: "thread-a" }, { threadId: "thread-forked" }]);
    expect(calls.setThreadCwd).toEqual([
      { threadId: "thread-a", cwd: "/tmp/thread-a" },
      { threadId: "thread-forked", cwd: "/tmp/thread-forked" },
    ]);
    expect(calls.bindSurfaceToThread).toHaveLength(2);
  });

  test("switches directly to loaded threads and resumes missing ones", async () => {
    const { orchestrator, calls } = makeHarness();
    await orchestrator.setSurfaceProject("chan-1", "~");

    const loaded = await orchestrator.switchSurfaceThread("chan-1", "thread-loaded", () => undefined);
    const resumed = await orchestrator.switchSurfaceThread("chan-1", "thread-missing", () => undefined);

    expect(loaded).toBe("thread-loaded");
    expect(resumed).toBe("thread-missing");
    expect(calls.bindSurfaceToThread).toContainEqual({
      adapter: "discord",
      surfaceId: "chan-1",
      threadId: "thread-loaded",
    });
    expect(calls.resumeThread).toContainEqual({
      threadId: "thread-missing",
      request: { cwd: "/tmp/thread-missing", sandbox: "workspace-write" },
    });
  });

  test("clears surface thread bindings and subscriptions", () => {
    const { orchestrator, calls } = makeHarness();
    orchestrator.clearSurfaceThread("chan-1");

    expect(calls.clearSurfaceBinding).toEqual([{ adapter: "discord", surfaceId: "chan-1" }]);
    expect(calls.unsubscribeSurfaceEvents).toEqual([{ adapter: "discord", surfaceId: "chan-1" }]);
  });
});
