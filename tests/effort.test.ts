import { expect, test } from "bun:test";
import { SessionManager } from "../server/core/session_manager.js";
import { CodexSession } from "../server/core/codex_session.js";
import { handleMessage } from "../server/adapters/discord/commands.js";

async function setup() {
  const manager = new SessionManager();
  const starts: unknown[][] = [];
  const session = {
    async startThread() { return { threadId: "thread-1", model: "test-model", reasoningEffort: "low" }; },
    async startTurn(...args: unknown[]) { starts.push(args); return "turn-1"; },
  };
  (manager as any).createManagedSession = async () => ({ session });
  const model = {
    id: "test-model", model: "test-model", displayName: "Test", description: "",
    hidden: false, isDefault: true, supportsPersonality: false,
    defaultReasoningEffort: "low",
    supportedReasoningEfforts: ["low", "high"].map((reasoningEffort) => ({ reasoningEffort, description: "" })),
  };
  manager.listModels = async () => ({ data: [model], nextCursor: null });
  await manager.createThread({ cwd: "/repo" });
  return { manager, session, starts, model };
}

test("effort applies on the next new turn and subsequent turns inherit it", async () => {
  const { manager, starts } = await setup();
  expect((await manager.getThreadEffort("thread-1")).currentEffort).toBe("low");
  await manager.setThreadEffort("thread-1", "high");
  expect(starts).toHaveLength(0);
  await manager.submitTurn("thread-1", { input: [] });
  expect(starts[0]?.[4]).toBe("high");
  expect(await manager.getThreadEffort("thread-1")).toMatchObject({ currentEffort: "high", pendingEffort: null });
  await manager.submitTurn("thread-1", { input: [] });
  expect(starts[1]?.[4]).toBeUndefined();
  expect((await manager.setThreadEffort("thread-1", "default")).pendingEffort).toBe("low");
  await expect(manager.setThreadEffort("thread-1", "ultra")).rejects.toThrow("Available: low, high");
});

test("failed turn starts retain pending effort, and new selections survive an in-flight start", async () => {
  const { manager, session } = await setup();
  await manager.setThreadEffort("thread-1", "high");
  session.startTurn = async () => { throw new Error("start failed"); };
  await expect(manager.submitTurn("thread-1", { input: [] })).rejects.toThrow("start failed");
  expect((await manager.getThreadEffort("thread-1")).pendingEffort).toBe("high");
  session.startTurn = async () => {
    await manager.setThreadEffort("thread-1", "low");
    return "turn-1";
  };
  await manager.submitTurn("thread-1", { input: [] });
  expect(await manager.getThreadEffort("thread-1")).toMatchObject({ currentEffort: "high", pendingEffort: "low" });
});

test("effort resolves the pending model across catalog pages", async () => {
  const { manager, model } = await setup();
  manager.setThreadModel("thread-1", "other");
  manager.listModels = async (request) => request.cursor
    ? { data: [{ ...model, model: "other", supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "" }] }], nextCursor: null }
    : { data: [model], nextCursor: "next" };
  expect((await manager.setThreadEffort("thread-1", "medium")).model).toBe("other");
  await expect(manager.setThreadEffort("thread-1", "high")).rejects.toThrow("Available: medium");
});

test("Codex turn/start forwards effort and resume exposes the effective effort", async () => {
  const session = new CodexSession("on-request");
  const requests: Array<{ method: string; params: any }> = [];
  session.initialize = async () => {};
  (session as any).sendRequest = async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { thread: { id: "thread-1" }, turn: { id: "turn-1" }, reasoningEffort: "medium" };
  };
  expect(await session.resumeThread("thread-1", {})).toMatchObject({ reasoningEffort: "medium" });
  await session.startTurn([], undefined, undefined, "/repo", "high");
  expect(requests.at(-1)).toMatchObject({ method: "turn/start", params: { threadId: "thread-1", effort: "high" } });
});

test("Discord effort commands display settings, validate usage and require a thread", async () => {
  const { manager } = await setup();
  const replies: unknown[] = [];
  let thread: string | null = "thread-1";
  const message = {
    content: "!effort set high", channelId: "channel-1", author: { id: "user-1" },
    async reply(payload: unknown) { replies.push(payload); return { id: "reply-1" }; },
  };
  const context = { conversation: manager, getSurfaceThreadId: () => thread };
  await handleMessage(message as never, context as never);
  expect(JSON.stringify(replies.at(-1))).toContain("Pending next turn: high");
  message.content = "!effort";
  await handleMessage(message as never, context as never);
  expect(JSON.stringify(replies.at(-1))).toContain("Available: low, high");
  message.content = "!effort set invalid";
  await handleMessage(message as never, context as never);
  expect(JSON.stringify(replies.at(-1))).toContain("Unsupported effort");
  message.content = "!effort set";
  await handleMessage(message as never, context as never);
  expect(JSON.stringify(replies.at(-1))).toContain("Usage:");
  thread = null;
  message.content = "!effort";
  await handleMessage(message as never, context as never);
  expect(JSON.stringify(replies.at(-1))).toContain("Thread required");
});
