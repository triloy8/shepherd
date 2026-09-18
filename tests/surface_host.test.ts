import { expect, test } from "bun:test";
import { createSurfaceHost } from "../server/runtime/surface_host.js";
import { createHostRuntime } from "../server/runtime/host_runtime.js";
import { readRuntimeConfig } from "../server/config/runtime_environment.js";
import type { PreparedSurface, SurfaceAdapterContext } from "../server/runtime/surface_adapter.js";
import type { RegisteredSignal } from "../server/core/signal_registry.js";

function harness(surfaces: PreparedSurface[], failSignals = false) {
  const calls: string[] = [];
  let hosts = 0;
  let signals = 0;
  let shared!: ReturnType<typeof createHostRuntime>;
  let notice!: (signal: RegisteredSignal) => Promise<void>;
  const host = createSurfaceHost({
    config: readRuntimeConfig({}), surfaces,
    createHost(options) { hosts++; shared = createHostRuntime(options); return shared; },
    createSignals(runtime, beforeExecute) {
      expect(runtime).toBe(shared);
      signals++;
      notice = beforeExecute;
      return {
        url: null,
        start() { calls.push("signals.start"); if (failSignals) throw new Error("signal bind failed"); },
        async stop() { calls.push("signals.stop"); },
      };
    },
    onHealth(id, health) { calls.push(`${id}.${health.state}`); },
  });
  return { host, calls, shared, hosts: () => hosts, signals: () => signals, notice: (signal: RegisteredSignal) => notice(signal) };
}

function adapter(id: string, contexts: Map<string, SurfaceAdapterContext>, stops: string[], start = async () => {}) : PreparedSurface {
  return { id, create(context) {
    contexts.set(id, context);
    return { start, stop() { stops.push(id); } };
  } };
}

test("two adapters share one host and signals but keep independent application state", async () => {
  const contexts = new Map<string, SurfaceAdapterContext>();
  const stops: string[] = [];
  const h = harness([adapter("alpha", contexts, stops), adapter("beta", contexts, stops)]);
  try {
    const first = h.host.start();
    expect(h.host.start()).toBe(first);
    await first;
    expect(h.hosts()).toBe(1);
    expect(h.signals()).toBe(1);
    const a = contexts.get("alpha")!;
    const b = contexts.get("beta")!;
    const appA = a.createApplication(() => {});
    const appB = b.createApplication(() => {});
    appA.pauseSurfaceListening("same-id");
    expect(appA.getSurfaceListeningMode("same-id")).toBe("paused");
    expect(appB.getSurfaceListeningMode("same-id")).toBe("mention");
    expect(appA.runtimeLifecycle).toBe(appB.runtimeLifecycle);
    expect(a.signal).toBe(b.signal);
    expect("stopAll" in a.ingress).toBe(false);
    expect("submitTurn" in a.interactions).toBe(false);
    expect(h.host.health()).toEqual({ alpha: { state: "ready" }, beta: { state: "ready" } });
    const copy = h.host.health(); copy.alpha!.state = "stopped";
    expect(h.host.health().alpha!.state).toBe("ready");
    const shutdown = h.host.stop();
    expect(h.host.stop()).toBe(shutdown);
    await shutdown;
    expect(stops).toEqual(["alpha", "beta"]);
    expect(a.signal.aborted).toBe(true);
    expect(a.isQuiescing()).toBe(true);
    expect(h.calls.filter((call) => call === "signals.stop")).toHaveLength(1);
    expect(h.calls.indexOf("signals.stop")).toBeLessThan(h.calls.indexOf("alpha.stopped"));
  } finally { await h.host.stop(); }
});

test("adapter degradation and recovery leave the other adapter and runtime alive", async () => {
  const contexts = new Map<string, SurfaceAdapterContext>(); const stops: string[] = [];
  const h = harness([adapter("alpha", contexts, stops), adapter("beta", contexts, stops)]);
  try {
    await h.host.start();
    contexts.get("alpha")!.reportHealth({ state: "degraded", detail: "disconnected" });
    expect(h.host.health().alpha!.state).toBe("degraded");
    expect(h.host.health().beta!.state).toBe("ready");
    expect(h.shared.shepherd.isQuiescing()).toBe(false);
    expect(stops).toEqual([]);
    contexts.get("alpha")!.reportHealth({ state: "ready" });
    expect(h.host.health().alpha!.state).toBe("ready");
  } finally { await h.host.stop(); }
});

test("partial startup failure cleans both initialized adapters and signals exactly once", async () => {
  const contexts = new Map<string, SurfaceAdapterContext>(); const stops: string[] = [];
  const h = harness([
    adapter("alpha", contexts, stops),
    adapter("beta", contexts, stops, async () => { throw new Error("login failed"); }),
    adapter("gamma", contexts, stops),
  ]);
  await expect(h.host.start()).rejects.toThrow("login failed");
  await h.host.stop();
  expect(stops).toEqual(["alpha", "beta"]);
  expect(contexts.has("gamma")).toBe(false);
  expect(h.calls).not.toContain("signals.start");
  expect(h.calls.filter((call) => call === "signals.stop")).toHaveLength(1);
});

test("signal listener startup failure cleans initialized adapters", async () => {
  const stops: string[] = [];
  const h = harness([adapter("alpha", new Map(), stops)], true);
  await expect(h.host.start()).rejects.toThrow("signal bind failed");
  expect(stops).toEqual(["alpha"]);
  expect(h.shared.shepherd.isQuiescing()).toBe(true);
});

test("failed cleanup does not skip remaining adapters", async () => {
  const stops: string[] = [];
  const h = harness([
    { id: "alpha", create: () => ({ async start() {}, stop() { throw new Error("stop failed"); } }) },
    adapter("beta", new Map(), stops),
  ]);
  await h.host.start();
  await expect(h.host.stop()).rejects.toThrow("stop failed");
  expect(stops).toEqual(["beta"]);
  expect(h.host.health().alpha!.state).toBe("stopped");
});

test("shutdown aborts pending startup and never starts the next adapter", async () => {
  const contexts = new Map<string, SurfaceAdapterContext>(); const stops: string[] = [];
  let entered!: () => void;
  const entering = new Promise<void>((resolve) => { entered = resolve; });
  const h = harness([
    { id: "alpha", create(context) {
      contexts.set("alpha", context);
      return {
        start: () => new Promise<void>((resolve) => { context.signal.addEventListener("abort", () => resolve(), { once: true }); entered(); }),
        stop() { stops.push("alpha"); },
      };
    } },
    adapter("beta", contexts, stops),
  ]);
  const starting = h.host.start();
  const rejected = starting.catch((error) => error);
  await entering;
  await h.host.stop();
  expect((await rejected).message).toContain("stopped during surface startup");
  expect(contexts.has("beta")).toBe(false);
  expect(stops).toEqual(["alpha"]);
  contexts.get("alpha")!.reportHealth({ state: "ready" });
  expect(h.host.health().alpha!.state).toBe("stopped");
});

test("signal notices route only to their target adapter and presentation failure is isolated", async () => {
  const notices: string[] = [];
  const surfaces: PreparedSurface[] = ["alpha", "beta"].map((id) => ({ id, create: () => ({
    async start() {}, stop() {}, async presentSignal() { notices.push(id); if (id === "alpha") throw new Error("delivery failed"); },
  }) }));
  const h = harness(surfaces);
  try {
    await h.host.start();
    const signal = (id: string) => ({ target: { delivery: { adapter: id, surfaceId: "surface" } } } as RegisteredSignal);
    await h.notice(signal("alpha"));
    await h.notice(signal("beta"));
    await h.notice(signal("disabled"));
    expect(notices).toEqual(["alpha", "beta"]);
    expect(h.shared.shepherd.isQuiescing()).toBe(false);
  } finally { await h.host.stop(); }
});

test("invalid prepared selections cannot create a runtime", () => {
  let creates = 0;
  for (const surfaces of [[], [{ id: "same", create: () => { throw 0; } }, { id: "same", create: () => { throw 0; } }]]) {
    expect(() => createSurfaceHost({ config: readRuntimeConfig({}), surfaces, createHost() { creates++; throw 0; } })).toThrow();
  }
  expect(creates).toBe(0);
});

test("a host stopped before startup cannot allocate adapter or signal resources", async () => {
  const contexts = new Map<string, SurfaceAdapterContext>();
  const h = harness([adapter("alpha", contexts, [])]);
  await h.host.stop();
  await expect(h.host.start()).rejects.toThrow("stopping");
  expect(contexts.size).toBe(0);
  expect(h.signals()).toBe(0);
});
