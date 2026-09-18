import { expect, test } from "bun:test";
import { SignalRuntime } from "../server/runtime/signal_runtime.js";
import { ShepherdRuntime } from "../server/runtime/shepherd_runtime.js";
import type { DynamicToolRegistration } from "../server/core/dynamic_tool_registry.js";
import type { WebhookSignalServerOptions } from "../server/adapters/webhook/server.js";

function harness() {
  const runtime = new ShepherdRuntime({
    approvalPolicy: "on-request",
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
const config = { enabled: true, hostname: "127.0.0.1", port: 0, maxBodyBytes: 65536, queueCapacity: 10 };

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
