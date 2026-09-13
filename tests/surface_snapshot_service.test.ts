import { expect, test } from "bun:test";
import { readSurfaceStatus, readSurfaceBinding, planSurfaceRecovery, type SurfaceStatusReader } from "../server/core/surface_snapshot_service.js";

function reader(threadId: string | null): SurfaceStatusReader {
  return {
    getSurfaceThreadId: () => threadId,
    getSurfaceProject: () => "~/project with spaces",
    getSurfaceListeningMode: () => "open",
    conversation: {
      getThreadState: () => { if (!threadId) throw new Error("unexpected read"); return { activeTurnId: "turn-1" }; },
      getThreadModel: () => ({ threadId: threadId!, currentModel: "current", pendingModel: "next", modelProvider: "openai" }),
    },
  };
}

test("status preserves current/pending model data and activity without presentation", () => {
  expect(readSurfaceStatus(reader("thread-1"), "terminal-1")).toEqual({
    surfaceId: "terminal-1", project: "~/project with spaces", threadId: "thread-1", listeningMode: "open",
    activeTurnId: "turn-1", model: { threadId: "thread-1", currentModel: "current", pendingModel: "next", modelProvider: "openai" },
  });
  expect(readSurfaceStatus(reader(null), "terminal-1")).toMatchObject({ threadId: null, activeTurnId: null, model: null });
});

test("recovery orders project, thread, and listening and never opens an unbound surface", () => {
  const binding = readSurfaceBinding(reader("thread-1"), "terminal-1");
  expect(planSurfaceRecovery(binding)).toEqual([
    { type: "repo.set", repoInput: "~/project with spaces" },
    { type: "thread.switch", threadId: "thread-1" },
    { type: "listening.set", mode: "open" },
  ]);
  expect(planSurfaceRecovery({ ...binding, listeningMode: "paused" })).toHaveLength(2);
  expect(planSurfaceRecovery({ ...binding, threadId: null })).toEqual([{ type: "repo.set", repoInput: "~/project with spaces" }]);
  expect(planSurfaceRecovery({ ...binding, threadId: null, project: null })).toEqual([]);
});
