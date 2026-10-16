import { expect, test } from "bun:test";
import { SessionManager } from "../server/core/session_manager.js";
import { CodexSession } from "../server/providers/codex/session.js";
import { handleMessage } from "../server/adapters/discord/commands.js";
import { bridgeEvent } from "../shared/protocol/events.js";
import type { TurnSettings } from "../server/ports/provider_session.js";

/** Report applied settings as an adapter does when a turn starts. */
function reportSettings(session: CodexSession, applied: { model: string | null; effort: string | null }, settings: TurnSettings) {
  if (settings.model) applied.model = settings.model;
  if (settings.effort !== undefined) applied.effort = settings.effort;
  session.eventBus.publish(bridgeEvent({ id: crypto.randomUUID(), type: "thread.settings.changed", threadId: "thread-1", sessionId: session.sessionId, ts: "now", payload: { ...applied, cwd: "/repo", approvalPolicy: "review_sensitive" } }));
}

async function setup() {
  const starts: TurnSettings[] = [];
  const session = new CodexSession("review_sensitive");
  const applied = { model: "test-model" as string | null, effort: "low" as string | null };
  session.startThread = async () => ({ threadId: "thread-1", cwd: "/repo", ...applied, approvalPolicy: "review_sensitive" });
  session.startTurn = async (_input, settings = {}) => { starts.push(settings); reportSettings(session, applied, settings); return "turn-1"; };
  const manager = new SessionManager(undefined, () => session);
  const model = {
    id: "test-model", displayName: "Test", description: "",
    hidden: false, isDefault: true,
    inputModalities: ["text", "image"] as const, defaultEffort: "low",
    supportedEfforts: ["low", "high"].map((value) => ({ value, description: "" })),
  };
  session.listModels = async () => ({ data: [model], nextCursor: null });
  await manager.createThread({ cwd: "/repo" });
  return { manager, session, starts, model, applied };
}

test("effort applies on the next new turn and subsequent turns inherit it", async () => {
  const { manager, starts } = await setup();
  expect((await manager.getThreadEffort("thread-1")).currentEffort).toBe("low");
  await manager.setThreadEffort("thread-1", "high");
  expect(starts).toHaveLength(0);
  await manager.submitTurn("thread-1", { input: [] });
  expect(starts[0]?.effort).toBe("high");
  expect(await manager.getThreadEffort("thread-1")).toMatchObject({ currentEffort: "high", pendingEffort: null });
  await manager.submitTurn("thread-1", { input: [] });
  expect(starts[1]?.effort).toBeUndefined();
  expect((await manager.setThreadEffort("thread-1", { mode: "default" })).pendingEffort).toBe("low");
  await expect(manager.setThreadEffort("thread-1", "ultra")).rejects.toMatchObject({ failure: { code: "unsupported_effort", available: ["low", "high"] } });
});

test("failed turn starts retain pending effort, and new selections survive an in-flight start", async () => {
  const { manager, session, applied } = await setup();
  await manager.setThreadEffort("thread-1", "high");
  session.startTurn = async () => { throw new Error("start failed"); };
  await expect(manager.submitTurn("thread-1", { input: [] })).rejects.toThrow("start failed");
  expect((await manager.getThreadEffort("thread-1")).pendingEffort).toBe("high");
  session.startTurn = async (_input, settings = {}) => {
    await manager.setThreadEffort("thread-1", "low");
    reportSettings(session, applied, settings);
    return "turn-1";
  };
  await manager.submitTurn("thread-1", { input: [] });
  expect(await manager.getThreadEffort("thread-1")).toMatchObject({ currentEffort: "high", pendingEffort: "low" });
});

test("effort resolves the pending model across catalog pages", async () => {
  const { manager, session, model } = await setup();
  manager.setThreadModel("thread-1", "other");
  session.listModels = async (request) => request.cursor
    ? { data: [{ ...model, id: "other", supportedEfforts: [{ value: "medium", description: "" }] }], nextCursor: null }
    : { data: [model], nextCursor: "next" };
  expect((await manager.setThreadEffort("thread-1", "medium")).model).toBe("other");
  await expect(manager.setThreadEffort("thread-1", "high")).rejects.toMatchObject({ failure: { code: "unsupported_effort", available: ["medium"] } });
});

test("a model switch rejects incompatible pending effort before execution and keeps it retryable", async () => {
  const { manager, session, starts, model } = await setup();
  session.listModels = async () => ({ data: [model, {
    ...model, id: "other", inputModalities: ["text", "image"] as const, defaultEffort: "medium", supportedEfforts: [{ value: "medium", description: "" }],
  }], nextCursor: null });
  await manager.setThreadEffort("thread-1", "high");
  manager.setThreadModel("thread-1", "other");
  await expect(manager.submitTurn("thread-1", { input: [] })).rejects.toMatchObject({
    failure: { code: "unsupported_effort", model: "other", requested: "high", available: ["medium"] },
  });
  expect(starts).toHaveLength(0);
  expect(manager.getThreadModel("thread-1").pendingModel).toBe("other");
  expect((await manager.getThreadEffort("thread-1")).pendingEffort).toBe("high");
  await manager.setThreadEffort("thread-1", { mode: "default" });
  await manager.submitTurn("thread-1", { input: [] });
  expect(starts[0]).toMatchObject({ model: "other", effort: "medium" });
});

test("direct turn model and effort overrides are validated against the requested model", async () => {
  const { manager, session, starts, model } = await setup();
  session.listModels = async request => request.cursor
    ? { data: [{ ...model, id: "other", supportedEfforts: [{ value: "medium", description: "" }] }], nextCursor: null }
    : { data: [model], nextCursor: "next" };
  await expect(manager.submitTurn("thread-1", { input: [], model: "other", effort: "high" })).rejects.toMatchObject({
    failure: { code: "unsupported_effort", model: "other" },
  });
  expect(starts).toHaveLength(0);
  await manager.submitTurn("thread-1", { input: [], model: "other", effort: "medium" });
  expect(starts[0]).toMatchObject({ model: "other", effort: "medium" });
});

test("Codex turn/start forwards effort and resume exposes the effective effort", async () => {
  const session = new CodexSession("review_sensitive");
  const requests: Array<{ method: string; params: any }> = [];
  session.initialize = async () => {};
  (session as any).sendRequest = async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { thread: { id: "thread-1", cwd: "/repo" }, turn: { id: "turn-1" }, reasoningEffort: "medium" };
  };
  expect(await session.resumeThread("thread-1", {})).toMatchObject({ effort: "medium" });
  await session.startTurn([], { effort: "high" });
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
