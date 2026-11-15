import { expect, test } from "bun:test";
import { SignalRuntime } from "../server/runtime/signal_runtime.js";
import { ShepherdRuntime } from "../server/runtime/shepherd_runtime.js";
import type { DynamicToolRegistration } from "../server/core/conversation/dynamic_tool_registry.js";
import type { WebhookSignalServerOptions } from "../server/adapters/webhook/server.js";

function harness() {
  const runtime = new ShepherdRuntime({
    approvalPolicy: "review_sensitive",
    deployment: {
      isDeploymentInProgress: () => false,
      async deploy() { throw new Error("unused"); },
      async readStatus() { return { deployedCommit: "abc", matchingRemoteRefs: [], deploymentInProgress: false }; },
    },
  });
  const tools: DynamicToolRegistration[] = [];
  let unregisters = 0;
  runtime.conversation.registerDynamicTool = (tool) => { tools.push(tool); return () => { unregisters++; }; };
  return { runtime, tools, unregisters: () => unregisters };
}
function makeSignals(h: ReturnType<typeof harness>, options: ConstructorParameters<typeof SignalRuntime>[1]) {
  const signals = new SignalRuntime(h.runtime, options);
  h.runtime.registerShutdownHook(() => signals.stop());
  return signals;
}
const config = { enabled: true, hostname: "127.0.0.1", port: 0, maxBodyBytes: 65536, queueCapacity: 10, threadWatchEnabled: false };

test("disabled signal composition registers no tool or listener", async () => {
  const h = harness();
  const signals = makeSignals(h, {
    config: { ...config, enabled: false },
    startServer() { throw new Error("must not listen"); },
  });
  signals.start();
  expect(signals.url).toBeNull();
  expect(h.tools).toEqual([]);
  await h.runtime.shutdown();
  expect(h.unregisters()).toBe(0);
});

test("shared signal listener starts once and follows process quiescing and shutdown", async () => {
  const h = harness();
  let starts = 0;
  let stops = 0;
  let options!: WebhookSignalServerOptions;
  const signals = makeSignals(h, {
    config,
    startServer(value) {
      starts++;
      options = value;
      return { hostname: config.hostname, port: 8787, url: "http://127.0.0.1:8787", async stop() { stops++; } };
    },
  });
  expect(h.tools.map((tool) => tool.name)).toEqual(["get_signal_callback"]);
  signals.start();
  signals.start();
  expect(starts).toBe(1);
  expect(options.isAvailable?.()).toBe(true);
  const shutdown = h.runtime.shutdown();
  expect(options.isAvailable?.()).toBe(false);
  await shutdown;
  await signals.stop();
  expect(stops).toBe(1);
  expect(h.unregisters()).toBe(1);
  expect(signals.url).toBeNull();
  expect(() => signals.start()).toThrow("stopping");
});

test("failed listener startup remains cleanable without skipping other adapters", async () => {
  const h = harness();
  let adapterStopped = false;
  const signals = makeSignals(h, {
    config,
    startServer() { throw new Error("address in use"); },
  });
  h.runtime.registerShutdownHook(() => { adapterStopped = true; });
  expect(() => signals.start()).toThrow("address in use");
  await h.runtime.shutdown();
  expect(h.unregisters()).toBe(1);
  expect(adapterStopped).toBe(true);
});

test("shared composition serves loopback health without starting Discord", async () => {
  const h = harness();
  const signals = makeSignals(h, { config });
  try {
    signals.start();
    const response = await fetch(`${signals.url}/health`);
    expect(response.status).toBe(200);
  } finally {
    await h.runtime.shutdown();
  }
});

test("thread watch tools register only when enabled, without the webhook, and unregister on stop", async () => {
  const h = harness();
  const signals = makeSignals(h, {
    config: { ...config, enabled: false, threadWatchEnabled: true },
    startServer() { throw new Error("must not listen"); },
  });
  signals.start();
  expect(signals.url).toBeNull();
  expect(h.tools.map((tool) => tool.name)).toEqual(["watch_threads", "unwatch_threads", "list_watched_threads"]);
  await h.runtime.shutdown();
  expect(h.unregisters()).toBe(3);
});

test("managed swarm watches work with public watches and webhook disabled and stop with the host", async () => {
  const h = harness();
  const signals = makeSignals(h, { config: { ...config, enabled: false, threadWatchEnabled: false } });
  const subscriptions: Array<(event: import("../shared/protocol/events.js").BridgeEvent) => void> = [];
  let removed = 0;
  h.runtime.conversation.getThreadState = id => ({ threadId: id, sessionId: id, activeTurnId: id === "manager" ? "manager-turn" : null } as never);
  h.runtime.conversation.getThreadSurface = id => ({ adapter: "swarm", surfaceId: id });
  h.runtime.conversation.getThreadCwd = async () => "/workspace";
  h.runtime.conversation.subscribeToThreadEvents = (_id, listener) => { subscriptions.push(listener); return () => { removed++; }; };
  signals.start();
  expect(h.tools).toEqual([]);
  const params = { threadId: "manager", turnId: "manager-turn", callId: "call", namespace: "shepherd", tool: "swarm_status", arguments: {} };
  expect((await signals.watchSwarm(params, "group-1", [{ threadId: "worker", label: "Solu" }])).success).toBe(true);
  expect(subscriptions.length).toBeGreaterThan(0);
  await h.runtime.shutdown();
  expect(removed).toBe(subscriptions.length);
  expect(() => signals.watchSwarm(params, "group-1", [{ threadId: "worker", label: "Solu" }])).toThrow("stopping");
});

test("managed worker completion queues a manager turn until its current turn ends", async () => {
  const h = harness();
  const signals = makeSignals(h, { config: { ...config, enabled: false, threadWatchEnabled: false } });
  const listeners = new Map<string, Set<(event: import("../shared/protocol/events.js").BridgeEvent) => void>>();
  let managerTurn: string | null = "manager-turn";
  const submissions: unknown[] = [];
  const emit = (threadId: string, turnId: string) => { for (const listener of [...listeners.get(threadId) ?? []]) listener({ id: crypto.randomUUID(), threadId, sessionId: threadId, ts: new Date().toISOString(), type: "turn.completed", payload: { turnId } }); };
  h.runtime.conversation.getThreadState = id => ({ threadId: id, sessionId: id, activeTurnId: id === "manager" ? managerTurn : null } as never);
  h.runtime.conversation.getThreadSurface = id => ({ adapter: "swarm", surfaceId: id });
  h.runtime.conversation.getSurfaceThread = (_adapter, surfaceId) => surfaceId;
  h.runtime.conversation.getThreadCwd = async () => "/workspace";
  h.runtime.conversation.subscribeToThreadEvents = (id, listener) => { const set = listeners.get(id) ?? new Set(); set.add(listener); listeners.set(id, set); return () => { set.delete(listener); }; };
  h.runtime.conversation.submitTurn = async (id, request) => { submissions.push({ id, input: request.input }); queueMicrotask(() => emit(id, "wake-turn")); return { ok: true, turnId: "wake-turn" }; };
  try {
    signals.start();
    const params = { threadId: "manager", turnId: "manager-turn", callId: "call", namespace: "shepherd", tool: "swarm_status", arguments: {} };
    expect((await signals.watchSwarm(params, "team", [{ threadId: "worker", label: "Solu" }])).success).toBe(true);
    emit("worker", "worker-turn");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(submissions).toEqual([]);
    managerTurn = null; emit("manager", "manager-turn");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(submissions).toHaveLength(1);
    expect(JSON.stringify(submissions)).toContain("Solu");
    expect(JSON.stringify(submissions)).toContain("completed");
  } finally { await h.runtime.shutdown(); }
});
