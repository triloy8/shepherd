import { expect, test } from "bun:test";
import { CodexSession } from "../server/core/codex_session.js";
import { SessionManager } from "../server/core/session_manager.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const started = { threadId: "thread", model: "model", modelProvider: "provider", reasoningEffort: null };
function harness() {
  const gate = deferred<typeof started>();
  const sessions: CodexSession[] = [];
  let stops = 0;
  let reads = 0;
  const manager = new SessionManager(undefined, (policy, tools) => {
    const session = new CodexSession(policy, tools);
    session.startThread = async () => gate.promise;
    session.resumeThread = async () => gate.promise;
    session.forkThread = async () => gate.promise;
    session.initialize = async () => { await gate.promise; };
    session.listStoredThreads = async () => { reads++; return { data: [] }; };
    session.stop = () => { stops++; };
    sessions.push(session);
    return session;
  });
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

test("concurrent catalog reads share initialization and shutdown owns pending control session", async () => {
  const h = harness();
  const first = h.manager.listStoredThreads({});
  const second = h.manager.listStoredThreads({});
  expect(h.sessions).toHaveLength(1);
  h.manager.stopAll();
  expect(h.stops()).toBe(1);
  const settled = Promise.allSettled([first, second]);
  h.gate.resolve(started);
  for (const result of await settled) {
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.reason.message).toContain("stopped");
  }
  expect(h.reads()).toBe(0);
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

test("failed initialization releases sessions and allows later retries", async () => {
  const h = harness();
  const result = h.manager.listStoredThreads({});
  h.gate.reject(new Error("bootstrap failed"));
  await expect(result).rejects.toThrow("bootstrap failed");
  expect(h.stops()).toBe(1);
  await expect(h.manager.listStoredThreads({})).rejects.toThrow("bootstrap failed");
  expect(h.sessions).toHaveLength(2);
  expect(h.stops()).toBe(2);
  h.manager.stopAll();
  expect(h.stops()).toBe(2);
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
  const session = new CodexSession("on-request");
  session.stop();
  await expect(session.start()).rejects.toThrow("stopped");
  await expect(session.initialize()).rejects.toThrow("stopped");
});
