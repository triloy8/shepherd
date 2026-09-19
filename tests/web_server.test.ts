import { expect, test } from "bun:test";
import { createWebAdapter } from "../server/adapters/web/server.js";
import { webHarness } from "./helpers/web_harness.js";
import { createSurfaceHost } from "../server/runtime/surface_host.js";
import { createHostRuntime } from "../server/runtime/host_runtime.js";
import { readRuntimeConfig } from "../server/config/runtime_environment.js";
import type { SurfaceAdapterContext } from "../server/runtime/surface_adapter.js";

const headers = { "content-type": "application/json" };

test("real loopback HTTP server checks origins, streams, and closes resources on stop", async () => {
  const h = webHarness();
  const adapter = createWebAdapter(h.context, { ...h.config, port: 0 });
  const abort = new AbortController();
  try {
    await adapter.start(); await adapter.start();
    const url = adapter.url()!;
    expect(url).toStartWith("http://127.0.0.1:");
    expect((await fetch(`${url}/api/v1/health`, { headers: { origin: "https://untrusted.test" } })).status).toBe(403);
    expect((await fetch(`${url}/api/v1/health`, { headers })).status).toBe(200);
    const c = await (await fetch(`${url}/api/v1/conversations`, { method: "POST", headers, body: JSON.stringify({ project: "~" }) })).json();
    const stream = await fetch(`${url}/api/v1/conversations/${c.id}/events`, { headers, signal: abort.signal });
    expect(stream.headers.get("content-type")).toBe("text/event-stream");
    const reader = stream.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(": connected");
    expect((await fetch(`${url}/api/v1/conversations/${c.id}/messages`, { method: "POST", headers, body: JSON.stringify({ text: "hello" }) })).status).toBe(200);
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("turn.started");
    await reader.cancel();
    expect(h.active.get(c.threadId)).toBe("turn-1");
    const first = adapter.stop(); expect(adapter.stop()).toBe(first); await first;
    expect(adapter.url()).toBeNull(); expect(h.bindings.size).toBe(0);
    await expect(adapter.start()).rejects.toThrow("stopping");
  } finally { abort.abort(); await adapter.stop(); h.api.dispose(); }
}, 30_000);

test("listener bind failure is fatal and cleanable", async () => {
  const h = webHarness();
  const adapter = createWebAdapter(h.context, h.config, () => { throw new Error("address in use"); });
  await expect(adapter.start()).rejects.toThrow("address in use");
  await adapter.stop(); h.api.dispose();
});

test("web and another surface run together against the same application runtime", async () => {
  const h = webHarness();
  let web!: ReturnType<typeof createWebAdapter>;
  let other!: SurfaceAdapterContext;
  let shared!: ReturnType<typeof createHostRuntime>;
  let creates = 0;
  let stoppedOther = 0;
  const host = createSurfaceHost({
    config: readRuntimeConfig({}),
    createHost(options) {
      creates++;
      shared = createHostRuntime(options);
      shared.shepherd.conversation.listStoredThreads = async () => ({ threads: [], nextCursor: "shared-cursor", backwardsCursor: null });
      return shared;
    },
    surfaces: [
      { id: "other", create(context) { other = context; return { async start() {}, stop() { stoppedOther++; } }; } },
      { id: "web", create(context) { web = createWebAdapter(context, { ...h.config, port: 0 }); return web; } },
    ],
    onHealth() {},
  });
  try {
    await host.start();
    expect(creates).toBe(1);
    const url = web.url()!;
    expect((await (await fetch(`${url}/api/v1/threads`, { headers })).json()).nextCursor).toBe("shared-cursor");
    other.reportHealth({ state: "degraded", detail: "disconnected" });
    expect(host.health().web!.state).toBe("ready");
    expect((await fetch(`${url}/api/v1/health`, { headers })).status).toBe(200);
    expect(shared.shepherd.isQuiescing()).toBe(false);
    await host.stop();
    expect(stoppedOther).toBe(1); expect(web.url()).toBeNull();
  } finally { await host.stop(); h.api.dispose(); }
}, 30_000);
