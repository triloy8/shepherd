import { CodexProvider } from "../server/providers/codex/provider.js";
import { expect, test } from "bun:test";
import { sessionProviders } from "./helpers/session_providers.js";
import { CodexSession } from "../server/providers/codex/session.js";
import { SessionManager } from "../server/core/conversation/session_manager.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const started = { threadId: "thread", cwd: "/repo", model: "model", effort: null };
function harness() {
  const gate = deferred<typeof started>();
  const sessions: CodexSession[] = [];
  let stops = 0;
  let reads = 0;
  const manager = new SessionManager(undefined, sessionProviders((tools) => {
    const session = new CodexSession(tools);
    session.startThread = async () => gate.promise;
    session.resumeThread = async () => gate.promise;
    session.forkThread = async () => gate.promise;
    session.initialize = async () => { await gate.promise; };
    session.listStoredThreads = async () => { reads++; return { data: [] }; };
    session.stop = () => { stops++; };
    sessions.push(session);
    return session;
  }));
  return { gate, sessions, manager, stops: () => stops, reads: () => reads };
}

for (const kind of ["create", "resume", "fork"] as const) {
  test(`shutdown owns a pending ${kind} and rejects late completion`, async () => {
    const h = harness();
    const result = kind === "create" ? h.manager.createThread({}) : kind === "resume"
      ? h.manager.resumeThread("thread", {}) : h.manager.forkThread("thread", {});
    h.manager.stopAll();
    expect(h.stops()).toBe(1);
    h.gate.resolve(started);
    await expect(result).rejects.toThrow("stopped");
    expect(h.manager.listThreads().threads).toEqual([]);
    h.manager.stopAll();
    expect(h.stops()).toBe(1);
    await expect(h.manager.createThread({})).rejects.toThrow("stopped");
    expect(h.sessions).toHaveLength(1);
  });
}

test("concurrent resumes share one session and one bootstrap", async () => {
  const h = harness();
  const first = h.manager.resumeThread("thread", {});
  const second = h.manager.resumeThread("thread", {});
  h.gate.resolve(started);
  expect(await first).toEqual(await second);
  expect(h.sessions).toHaveLength(1);
  h.manager.stopAll();
  expect(h.stops()).toBe(1);
});

test("updates instructions on an already-loaded idle session without allocating a second session", async () => {
  const h = harness();
  const loaded = h.manager.resumeThread("thread", {});
  h.gate.resolve(started);
  await loaded;
  const requests: unknown[] = [];
  h.sessions[0]!.resumeThread = async (threadId, request) => { requests.push({ threadId, request }); return started; };
  await h.manager.updateThreadInstructions("thread", "Worker role");
  expect(h.sessions).toHaveLength(1);
  expect(requests).toEqual([{ threadId: "thread", request: { cwd: "/repo", model: "model", instructions: "Worker role" } }]);
  h.manager.stopAll();
});

test("turns wait for an in-flight instruction update and do not start after it fails", async () => {
  const h = harness();
  const loaded = h.manager.resumeThread("thread", {});
  h.gate.resolve(started);
  await loaded;
  const entered = deferred<void>();
  const release = deferred<typeof started>();
  let starts = 0;
  h.sessions[0]!.resumeThread = async () => { entered.resolve(); return release.promise; };
  h.sessions[0]!.listModels = async () => ({ data: [], nextCursor: null });
  h.sessions[0]!.startTurn = async () => { starts++; return "turn"; };
  const update = h.manager.updateThreadInstructions("thread", "Worker role");
  await entered.promise;
  const turn = h.manager.submitTurn("thread", { input: [] });
  await Promise.resolve();
  expect(starts).toBe(0);
  release.resolve(started);
  await update;
  await turn;
  expect(starts).toBe(1);
  h.manager.stopAll();

  const failed = harness();
  const loadedFailed = failed.manager.resumeThread("thread", {});
  failed.gate.resolve(started);
  await loadedFailed;
  const failedEntered = deferred<void>();
  const failure = deferred<typeof started>();
  let failedStarts = 0;
  failed.sessions[0]!.resumeThread = async () => { failedEntered.resolve(); return failure.promise; };
  failed.sessions[0]!.listModels = async () => ({ data: [], nextCursor: null });
  failed.sessions[0]!.startTurn = async () => { failedStarts++; return "turn"; };
  const updateFailure = failed.manager.updateThreadInstructions("thread", "Worker role");
  await failedEntered.promise;
  const turnAfterFailure = failed.manager.submitTurn("thread", { input: [] });
  const updateFailureResult = updateFailure.catch(error => error);
  const turnFailureResult = turnAfterFailure.catch(error => error);
  failure.reject(new Error("instruction update failed"));
  expect((await updateFailureResult).message).toBe("instruction update failed");
  expect((await turnFailureResult).message).toBe("instruction update failed");
  expect(failedStarts).toBe(0);
  failed.manager.stopAll();
});

test("Codex history shares one app-server client, and stopping the provider stops a client still starting", async () => {
  let release!: () => void; const clients: CodexSession[] = []; let stops = 0, reads = 0;
  const provider = new CodexProvider(() => {
    const client = new CodexSession();
    client.initialize = () => new Promise<void>(resolve => { release = resolve; });
    client.listStoredThreads = async () => { reads++; return { data: [], nextCursor: null }; };
    client.stop = () => { stops++; };
    clients.push(client); return client;
  });
  const reads1 = [provider.listStoredThreads({}), provider.listStoredThreads({})];
  expect(clients).toHaveLength(1);
  provider.stop(); release();
  await Promise.all(reads1);
  await Promise.resolve();
  expect(stops).toBe(1); expect(reads).toBe(2);
});

test("successful concurrent catalog reads share the control session", async () => {
  const h = harness();
  const results = [h.manager.listStoredThreads({}), h.manager.listStoredThreads({})];
  h.gate.resolve(started);
  await Promise.all(results);
  await h.manager.listStoredThreads({});
  expect(h.sessions).toHaveLength(1);
  expect(h.reads()).toBe(3);
  h.manager.stopAll();
});

test("a Codex history client that fails to start is replaced on the next request", async () => {
  let attempts = 0;
  const provider = new CodexProvider(() => {
    const client = new CodexSession();
    client.initialize = async () => { if (++attempts === 1) throw new Error("spawn failed"); };
    client.listStoredThreads = async () => ({ data: [], nextCursor: null });
    return client;
  });
  await expect(provider.listStoredThreads({})).rejects.toThrow("spawn failed");
  expect(await provider.listStoredThreads({})).toEqual({ data: [], nextCursor: null });
  expect(attempts).toBe(2);
  provider.stop();
});

test("failed thread bootstrap releases its session", async () => {
  const h = harness();
  const result = h.manager.createThread({});
  h.gate.reject(new Error("bootstrap failed"));
  await expect(result).rejects.toThrow("bootstrap failed");
  expect(h.stops()).toBe(1);
  expect(h.manager.listThreads().threads).toEqual([]);
  h.manager.stopAll();
  expect(h.stops()).toBe(1);
});

test("explicitly stopped Codex sessions cannot spawn a new process", async () => {
  const session = new CodexSession();
  session.stop();
  await expect(session.initialize()).rejects.toThrow("stopped");
});


test("saved cwd can be read before loading a thread without resuming it", async () => {
  let resumes = 0;
  const manager = new SessionManager(undefined, sessionProviders((tools) => {
    const session = new CodexSession(tools);
    session.initialize = async () => {};
    session.readThread = async (id) => ({ thread: { id, cwd: id === "missing" ? null : "/original/checkout" } });
    session.resumeThread = async () => { resumes++; return started; };
    session.stop = () => {};
    return session;
  }));
  try {
    expect(await manager.resolveThreadCwd("stored")).toBe("/original/checkout");
    expect(manager.listThreads().threads).toEqual([]);
    expect(resumes).toBe(0);
    await expect(manager.resolveThreadCwd("missing")).rejects.toMatchObject({ failure: { code: "workspace_unavailable" } });
  } finally { manager.stopAll(); }
});

test("revert preserves provider pagination cursors without loading full history", async () => {
  const h = harness();
  const ready = h.manager.resumeThread("thread", {});
  h.gate.resolve(started); await ready;
  const calls: unknown[] = [];
  h.sessions[0]!.revertThread = async (threadId, beforeTurnId) => {
    calls.push({ threadId, beforeTurnId });
    return { thread: { id: threadId, turns: [], extraMetadata: "retained" }, turnsBackwardsCursor: "turn-anchor", itemsBackwardsCursor: null };
  };
  expect(await h.manager.revertThread("thread", { beforeTurnId: "cutoff" })).toEqual({
    thread: { id: "thread", turns: [], extraMetadata: "retained" }, turnsBackwardsCursor: "turn-anchor", itemsBackwardsCursor: null,
  });
  expect(calls).toEqual([{ threadId: "thread", beforeTurnId: "cutoff" }]);
  h.sessions[0]!.revertThread = async () => ({});
  await expect(h.manager.revertThread("thread", { beforeTurnId: "cutoff" })).rejects.toThrow("updated thread state");
  h.manager.stopAll();
});
