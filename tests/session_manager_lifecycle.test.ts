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
