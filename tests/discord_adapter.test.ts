import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createDiscordAdapter } from "../server/adapters/discord/bot.js";
import type { SurfaceAdapterContext, SurfaceHealth } from "../server/runtime/surface_adapter.js";

function fixture() {
  const client = Object.assign(new EventEmitter(), {
    user: { tag: "test" },
    isReady: () => true,
    async login() {},
    async destroy() { destroys++; },
  });
  let destroys = 0;
  const health: SurfaceHealth[] = [];
  const abort = new AbortController();
  const context = {
    signal: abort.signal,
    approvalPolicy: "on-request",
    createApplication: () => ({}),
    reportHealth: (value: SurfaceHealth) => health.push(value),
    isQuiescing: () => abort.signal.aborted,
  } as SurfaceAdapterContext;
  const adapter = createDiscordAdapter(context, { token: "test", streaming: false }, client as never);
  return { client, adapter, health, abort, destroys: () => destroys };
}

test("Discord disconnect and recovery report adapter health without shutting down", async () => {
  const f = fixture();
  await f.adapter.start();
  f.client.emit("clientReady");
  f.client.emit("shardDisconnect", {}, 0);
  f.client.emit("shardResume", 0);
  expect(f.health.map(({ state }) => state)).toEqual(["ready", "degraded", "ready"]);
  expect(f.destroys()).toBe(0);
  const first = f.adapter.stop();
  expect(f.adapter.stop()).toBe(first);
  await first;
  expect(f.destroys()).toBe(1);
  f.client.emit("shardDisconnect", {}, 0);
  expect(f.health).toHaveLength(3);
});

test("Discord login failures propagate to host cleanup", async () => {
  const f = fixture();
  f.client.login = async () => { throw new Error("invalid credential"); };
  await expect(f.adapter.start()).rejects.toThrow("invalid credential");
  await f.adapter.stop();
  expect(f.destroys()).toBe(1);
});

test("Discord cannot become active after shutdown during login", async () => {
  const f = fixture();
  let finish!: () => void;
  f.client.login = () => new Promise<void>((resolve) => { finish = resolve; });
  const starting = f.adapter.start().catch((error) => error);
  f.abort.abort();
  await f.adapter.stop();
  finish();
  expect((await starting).message).toContain("stopped during login");
  expect(f.destroys()).toBe(2);
});
