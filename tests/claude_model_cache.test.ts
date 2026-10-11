import { expect, test } from "bun:test";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeModelCache } from "../server/providers/claude/model_cache";

const list = (value: string) => [{ value, displayName: value, description: "" }] as ModelInfo[];

function harness() {
  let now = 0, scope = "login-a", loads = 0;
  let next: () => Promise<ModelInfo[]> = async () => list(`v${loads}`);
  const cache = new ClaudeModelCache({ now: () => now, scope: () => scope, freshMs: 100, maxAgeMs: 1000 });
  return {
    cache,
    advance: (ms: number) => { now += ms; },
    login: (value: string) => { scope = value; },
    fail: () => { next = async () => { throw new Error("CLI unavailable"); }; },
    get: () => cache.get(() => { loads++; return next(); }),
    loads: () => loads,
  };
}

test("a fresh list is reused and concurrent first lookups share one load", async () => {
  const h = harness();
  const [first, second] = await Promise.all([h.get(), h.get()]);
  expect(first).toBe(second); expect(h.loads()).toBe(1);
  h.advance(99);
  await h.get();
  expect(h.loads()).toBe(1);
});

test("a stale list is returned immediately while it refreshes in the background", async () => {
  const h = harness();
  const original = await h.get();
  h.advance(500);
  expect(await h.get()).toBe(original);
  expect(h.loads()).toBe(2);
  await Promise.resolve(); await Promise.resolve();
  expect((await h.get())[0]!.value).toBe("v2");
  expect(h.loads()).toBe(2);
});

test("a failed background refresh keeps serving the previous list", async () => {
  const h = harness();
  const original = await h.get();
  h.fail(); h.advance(500);
  expect(await h.get()).toBe(original);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(await h.get()).toBe(original);
});

test("an expired list or a changed login waits for a new load", async () => {
  const h = harness();
  await h.get();
  h.advance(1000);
  expect((await h.get())[0]!.value).toBe("v2");
  h.login("login-b");
  expect((await h.get())[0]!.value).toBe("v3");
  expect(h.loads()).toBe(3);
});
