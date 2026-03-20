import { describe, expect, test } from "bun:test";

import type { BridgeEvent } from "../shared/protocol/events.js";
import { createDiscordSurfaceRuntime } from "../server/adapters/discord/surface_runtime.js";

function makeConversation() {
  const boundThreads: Array<{ adapter: string; surfaceId: string; threadId: string }> = [];
  const createdThreads: Array<{ adapter: string; surfaceId: string; request: Record<string, unknown> }> = [];
  const threadCwds: Array<{ threadId: string; cwd: string }> = [];

  return {
    boundThreads,
    createdThreads,
    threadCwds,
    conversation: {
      getSurfaceThread(_adapter: string, _surfaceId: string) {
        return "thread-current";
      },
      async bindSurfaceToThread(adapter: string, surfaceId: string, threadId: string) {
        boundThreads.push({ adapter, surfaceId, threadId });
        return threadId;
      },
      clearSurfaceBinding() {},
      subscribeSurfaceEvents() {
        return () => {};
      },
      unsubscribeSurfaceEvents() {},
      async createSurfaceThread(adapter: string, surfaceId: string, request: Record<string, unknown>) {
        createdThreads.push({ adapter, surfaceId, request });
        return { threadId: "thread-created", sessionId: "session-1" };
      },
      async resumeThread(threadId: string) {
        return { threadId, sessionId: "session-1" };
      },
      async forkThread() {
        return { threadId: "thread-forked", sessionId: "session-1" };
      },
      setThreadCwd(threadId: string, cwd: string) {
        threadCwds.push({ threadId, cwd });
      },
      getThreadState() {
        return { threadId: "thread-1", sessionId: "session-1", activeTurnId: null, approvalPolicy: "on-request" };
      },
    },
  };
}

const fsImpl = {
  async stat() {
    throw new Error("missing");
  },
  async mkdir() {},
};

describe("Discord surface runtime", () => {
  test("builds command context that delegates project binding to the orchestrator", async () => {
    const { conversation } = makeConversation();
    const events: Array<{ surfaceId: string; event: BridgeEvent }> = [];

    const runtime = createDiscordSurfaceRuntime({
      conversation: conversation as never,
      approvalPolicy: "on-request",
      defaultSandbox: "workspace-write",
      onThreadEvent: (surfaceId, event) => events.push({ surfaceId, event }),
      async cloneGithubRepo() {},
      async resolveGithubRepo(slug) {
        return slug;
      },
      workspaceProvisionerOptions: {
        fsImpl: fsImpl as never,
        homedirPath: "/tmp",
      },
    });

    await expect(runtime.commandContext.setSurfaceProject("chan-1", "owner/repo")).resolves.toEqual({
      repoSlug: "owner/repo",
    });
    expect(runtime.commandContext.getSurfaceProject("chan-1")).toBe("owner/repo");
    expect(runtime.commandContext.getSurfaceThreadId("chan-1")).toBe("thread-current");
    expect(events).toEqual([]);
  });

  test("wires thread creation through the orchestrator and thread event callback", async () => {
    const { conversation, createdThreads, threadCwds } = makeConversation();
    const events: Array<{ surfaceId: string; event: BridgeEvent }> = [];

    const runtime = createDiscordSurfaceRuntime({
      conversation: conversation as never,
      approvalPolicy: "on-request",
      defaultSandbox: "workspace-write",
      onThreadEvent: (surfaceId, event) => events.push({ surfaceId, event }),
      async cloneGithubRepo() {},
      async resolveGithubRepo(slug) {
        return slug;
      },
      workspaceProvisionerOptions: {
        fsImpl: fsImpl as never,
        homedirPath: "/tmp",
      },
    });

    await runtime.commandContext.setSurfaceProject("chan-1", "~/discord-surface-runtime-test");
    await expect(runtime.commandContext.createSurfaceThread("chan-1")).resolves.toBe("thread-created");
    expect(createdThreads).toHaveLength(1);
    expect(createdThreads[0]?.surfaceId).toBe("chan-1");
    expect(createdThreads[0]?.request).toEqual({
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    expect(threadCwds).toEqual([
      {
        threadId: "thread-created",
        cwd: "/home/tadhiel/discord-surface-runtime-test",
      },
    ]);
    expect(events).toEqual([]);
  });
});
