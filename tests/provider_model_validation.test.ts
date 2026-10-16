import { expect, test } from "bun:test";
import { SessionManager } from "../server/core/session_manager.js";
import { IndependentSession } from "./helpers/independent_provider.js";
import { CodexSession } from "../server/providers/codex/session.js";
import type { ModelSummary } from "../shared/protocol/requests.js";

const row: ModelSummary = { id: "third-model", displayName: "Third", description: "", hidden: false, isDefault: true, inputModalities: ["text"], defaultEffort: "focused", supportedEfforts: [{ value: "focused", description: "" }] };
for (const lifecycle of ["create", "resume", "fork"] as const) {
  test(`${lifecycle} validates model and effort before invoking provider lifecycle`, async () => {
    const session = new IndependentSession(); let calls = 0;
    session.listModels = async () => ({ data: [row], nextCursor: null });
    const start = async () => { calls++; return { threadId: "thread", cwd: "/tmp", model: row.id, effort: "focused", approvalPolicy: "provider_default" as const }; };
    Object.assign(session, { startThread: start, resumeThread: start, forkThread: start, capabilities: { ...session.capabilities, fork: true } });
    const manager = new SessionManager(undefined, () => session);
    const run = (request: { model?: string; effort?: string }) => lifecycle === "create" ? manager.createThread(request) : lifecycle === "resume" ? manager.resumeThread("saved", request) : manager.forkThread("saved", request);
    try {
      await expect(run({ model: "missing" })).rejects.toMatchObject({ failure: { code: "model_unavailable" } });
      await expect(run({ model: row.id, effort: "invalid" })).rejects.toMatchObject({ failure: { code: "unsupported_effort" } });
      await expect(run({ effort: "invalid" })).rejects.toMatchObject({ failure: { code: "unsupported_effort" } });
      expect(calls).toBe(0);
    } finally { manager.stopAll(); }
  });
}

test("ordinary text submission and steering validate the current model even with a different pending model", async () => {
  const session = new IndependentSession(); let starts = 0, steers = 0;
  session.listModels = async () => ({ data: [{ ...row, inputModalities: [] }, { ...row, id: "next", isDefault: false }], nextCursor: null });
  session.onTurn = () => { starts++; };
  session.steerTurn = async () => { steers++; return "turn"; };
  const manager = new SessionManager(undefined, () => session);
  try {
    const { threadId } = await manager.createThread({});
    const input = [{ type: "text" as const, text: "hello" }];
    await expect(manager.submitTurn(threadId, { input })).rejects.toThrow("text inputs");
    manager.setThreadModel(threadId, "next");
    await expect(manager.steerTurn(threadId, { input })).rejects.toThrow("text inputs");
    expect(starts).toBe(0); expect(steers).toBe(0);
    await manager.submitTurn(threadId, { input });
    expect(starts).toBe(1);
    await manager.steerTurn(threadId, { input });
    expect(steers).toBe(1);
  } finally { manager.stopAll(); }
});

test("switching to a model without effort clears inherited effort and commits only after a successful turn", async () => {
  const session = new IndependentSession(); const efforts: unknown[] = []; let fail = true;
  session.listModels = async () => ({ data: [row, { ...row, id: "simple", isDefault: false, supportedEfforts: [], defaultEffort: null }], nextCursor: null });
  session.onTurn = (_input, { effort }) => { efforts.push(effort); if (fail) throw new Error("start failed"); };
  const manager = new SessionManager(undefined, () => session);
  try {
    const { threadId } = await manager.createThread({});
    manager.setThreadModel(threadId, "simple");
    await expect(manager.submitTurn(threadId, { input: [] })).rejects.toThrow("start failed");
    expect(manager.getThreadModel(threadId).pendingModel).toBe("simple");
    fail = false;
    await manager.submitTurn(threadId, { input: [] });
    expect(efforts).toEqual([null, null]);
    expect((await manager.getThreadEffort(threadId)).currentEffort).toBeNull();
    await manager.submitTurn(threadId, { input: [] });
    expect(efforts.at(-1)).toBeUndefined();
  } finally { manager.stopAll(); }
});

test("Codex sends an explicit null effort instead of omitting the clear", async () => {
  const session = new CodexSession("provider_default"); session.threadId = "thread";
  let params: unknown;
  (session as unknown as { sendRequest: (method: string, input: unknown) => Promise<unknown> }).sendRequest = async (_method, input) => { params = input; return { turn: { id: "turn" } }; };
  try { await session.startTurn([], { effort: null }); expect(params).toMatchObject({ effort: null }); }
  finally { session.stop(); }
});

for (const lifecycle of ["resume", "fork"] as const) {
  test(`${lifecycle} effort-only requests validate against the saved model rather than the default`, async () => {
    const session = new IndependentSession();
    session.readThread = async id => ({ thread: { id, cwd: "/tmp", model: "saved-model" } });
    session.listModels = async () => ({ data: [row, { ...row, id: "saved-model", isDefault: false, defaultEffort: "slow", supportedEfforts: [{ value: "slow", description: "" }] }], nextCursor: null });
    let calls = 0;
    Object.assign(session, { capabilities: { ...session.capabilities, fork: true }, resumeThread: async () => { calls++; return { threadId: "saved", cwd: "/tmp", model: "saved-model", effort: "slow" }; }, forkThread: async () => { calls++; return { threadId: "fork", cwd: "/tmp", model: "saved-model", effort: "slow" }; } });
    const manager = new SessionManager(undefined, () => session);
    try {
      const run = (effort: string) => lifecycle === "resume" ? manager.resumeThread("saved", { effort }) : manager.forkThread("saved", { effort });
      await expect(run("focused")).rejects.toMatchObject({ failure: { code: "unsupported_effort", model: "saved-model" } });
      expect(calls).toBe(0);
      await run("slow"); expect(calls).toBe(1);
    } finally { manager.stopAll(); }
  });
}
