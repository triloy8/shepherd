import { expect, test } from "bun:test";
import type { AccountInfo, Query, query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAccountLimits } from "../server/providers/claude/account_limits.js";
import { emptyClaudeLimits, mapClaudeRateLimit, mapClaudeUsage } from "../server/providers/claude/account_limits_mapper.js";

const account: AccountInfo = { email: "fixture@example.invalid", subscriptionType: "pro", apiProvider: "firstParty" };
const usage = (percent: number | null = 12) => ({ subscription_type: "pro", rate_limits_available: true, rate_limits: {
  five_hour: { utilization: percent, resets_at: new Date(500_000).toISOString() },
  seven_day: { utilization: 0, resets_at: null }, extra_usage: { is_enabled: false, utilization: null },
} });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function sdk(read: () => Promise<unknown> = async () => usage(), identity: () => Promise<AccountInfo> = async () => account, supported = true) {
  let reads = 0;
  const calls: Array<{ prompt: AsyncIterable<SDKUserMessage>; options: Parameters<typeof query>[0]["options"]; closed: number }> = [];
  const open = ((input: Parameters<typeof query>[0]) => {
    const call = { prompt: input.prompt as AsyncIterable<SDKUserMessage>, options: input.options, closed: 0 }; calls.push(call);
    return { accountInfo: identity, close: () => { call.closed++; }, ...(supported ? {
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async (options: { skipBehaviors: boolean }) => { expect(options.skipBehaviors).toBe(true); reads++; return read(); },
    } : {}) } as Query;
  }) as typeof query;
  return { open, calls, reads: () => reads };
}

test("Claude mapper preserves zero/unknown percentages and distinguishes read percentages from event fractions", () => {
  const snapshot = mapClaudeUsage(usage(), account, 100)!;
  expect(snapshot.windows.map(row => row.usedPercent)).toEqual([12, 0]);
  expect(snapshot.windows[0]!.resetsAt).toBe(500);
  expect(mapClaudeUsage(usage(null), account, 100)!.windows[0]!.usedPercent).toBeNull();
  expect(mapClaudeRateLimit({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.82 }, 100)!.window.usedPercent).toBe(82);
  expect(mapClaudeRateLimit({ status: "allowed", rateLimitType: "five_hour" }, 100)!.window.usedPercent).toBeNull();
  expect(mapClaudeRateLimit({ status: "rejected", utilization: NaN, resetsAt: Infinity }, 100)!.window).toMatchObject({ status: "limited", usedPercent: null, resetsAt: null });
});

test("server usage rows are authoritative and retain model/surface buckets without duplicates", () => {
  const value = { ...usage(), rate_limits: { ...usage().rate_limits, limits: [
    { kind: "session", percent: 25, resets_at: null },
    { kind: "weekly_all", percent: 0 },
    { kind: "weekly_scoped", percent: 40, scope: { model: { display_name: "Opus" } } },
    { kind: "weekly_scoped", percent: 15, scope: { surface: { display_name: "Apps" } } },
    { kind: "new_window", percent: null },
  ] } };
  const result = mapClaudeUsage(value, account, 100)!;
  expect(result.windows.map(row => row.id)).toEqual(["five_hour", "seven_day", "seven_day_opus", "surface:Apps", "kind:new_window:4"]);
  expect(result.windows.map(row => row.usedPercent)).toEqual([25, 0, 40, 15, null]);
  expect(mapClaudeUsage({ ...value, rate_limits: { ...value.rate_limits, limits: [] } }, account, 100)!.windows).toEqual([]);
});

test("invalid replies, percentages and reset timestamps do not become fabricated zero usage", () => {
  expect(mapClaudeUsage({}, account, 100)).toBeNull();
  expect(mapClaudeUsage({ rate_limits_available: true, rate_limits: [] }, account, 100)).toBeNull();
  const result = mapClaudeUsage({ rate_limits_available: true, rate_limits: { five_hour: { utilization: "50", resets_at: "bad" } } }, account, 100)!;
  expect(result.windows[0]).toMatchObject({ usedPercent: null, resetsAt: null });
});

test("account reads coalesce, throttle refresh, skip transcript scans and submit no user messages", async () => {
  const gate = deferred<unknown>(); const fake = sdk(() => gate.promise);
  let now = 100;
  const reader = new ClaudeAccountLimits(fake.open, { now: () => now });
  const first = reader.read(); const second = reader.read({ refresh: true });
  expect(fake.calls).toHaveLength(1);
  gate.resolve(usage());
  expect((await first).windows[0]!.usedPercent).toBe(12);
  await second;
  expect(fake.calls[0]!.closed).toBe(1);
  expect(fake.calls[0]!.options).toMatchObject({ tools: [], mcpServers: {}, settingSources: [], permissionMode: "dontAsk" });
  expect(await fake.calls[0]!.prompt[Symbol.asyncIterator]().next()).toMatchObject({ done: true });
  await reader.read({ refresh: true }); expect(fake.calls).toHaveLength(1);
  now += 6; await reader.read({ refresh: true }); expect(fake.calls).toHaveLength(2);
  now += 1; await reader.read(); expect(fake.calls).toHaveLength(2);
  reader.stop();
});

test("native control removal falls back to shared account events", async () => {
  const fake = sdk(undefined, undefined, false); const reader = new ClaudeAccountLimits(fake.open, { now: () => 100 });
  reader.observe({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.9, resetsAt: 500 }, account, reader.scope());
  const result = await reader.read();
  expect(result).toMatchObject({ source: "events", availability: "available", stale: true });
  expect(result.windows[0]).toMatchObject({ usedPercent: 90, status: "warning" });
  expect(result.message).toContain("last reported");
  expect(fake.calls[0]!.closed).toBe(1); reader.stop();
});

test("later events replace omitted percentages instead of retaining data from the previous window", async () => {
  let now = 100; const reader = new ClaudeAccountLimits(sdk().open, { now: () => now, cacheSeconds: 1000 });
  await reader.read();
  reader.observe({ status: "rejected", rateLimitType: "five_hour", utilization: 1, resetsAt: 150 }, account, reader.scope());
  now = 151;
  expect((await reader.read({})).windows.find(row => row.id === "five_hour")!.stale).toBe(true);
  reader.observe({ status: "allowed", rateLimitType: "five_hour", resetsAt: 600 }, account, reader.scope());
  const result = await reader.read();
  expect(result.windows.find(row => row.id === "five_hour")).toMatchObject({ usedPercent: null, status: "available", resetsAt: 600, stale: false });
  reader.stop();
});

test("cached values become stale at reset and never reset themselves to zero", async () => {
  let now = 100; const reader = new ClaudeAccountLimits(sdk().open, { now: () => now, cacheSeconds: 1000 });
  await reader.read(); now = 501;
  const result = await reader.read();
  expect(result.windows[0]).toMatchObject({ usedPercent: 12, stale: true });
  reader.stop();
});

test("a full usage read cannot overwrite a newer event even at the same clock timestamp", async () => {
  const gate = deferred<unknown>(); const fake = sdk(() => gate.promise);
  const reader = new ClaudeAccountLimits(fake.open, { now: () => 100 });
  const pending = reader.read(); await Promise.resolve();
  reader.observe({ status: "rejected", rateLimitType: "five_hour", utilization: 1 }, account, reader.scope());
  gate.resolve(usage());
  const result = await pending;
  expect(result.windows.find(row => row.id === "five_hour")!.usedPercent).toBe(100); reader.stop();
});

test("API and signed-out accounts return appropriate availability without reading subscription usage", async () => {
  for (const identity of [{ apiProvider: "bedrock" }, { apiProvider: "firstParty", tokenSource: "none" }] as AccountInfo[]) {
    const fake = sdk(undefined, async () => identity); const reader = new ClaudeAccountLimits(fake.open);
    const result = await reader.read();
    expect(result.availability).toBe(identity.apiProvider === "bedrock" ? "not_applicable" : "unavailable");
    expect(result.windows).toEqual([]); expect(fake.reads()).toBe(0); reader.stop();
  }
});

test("account switches discard prior quotas and old-session events", async () => {
  let identity = account; let now = 100;
  const fake = sdk(async () => usage(4), async () => identity);
  const reader = new ClaudeAccountLimits(fake.open, { now: () => now });
  await reader.read(); identity = { ...account, email: "another@example.invalid" }; now += 6;
  await reader.read({ refresh: true });
  reader.observe({ status: "rejected", rateLimitType: "five_hour", utilization: 1 }, account, reader.scope());
  expect((await reader.read()).windows[0]!.usedPercent).toBe(4); reader.stop();
});

test("credential changes reject old observations and clear cached account information", async () => {
  const previous = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const reader = new ClaudeAccountLimits(sdk().open);
  try {
    const oldScope = reader.scope(); await reader.read();
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "fixture-new-credential";
    reader.observe({ status: "rejected", rateLimitType: "five_hour", utilization: 1 }, account, oldScope);
    const result = await reader.read(); expect(result.windows[0]!.usedPercent).toBe(12);
    expect(JSON.stringify(result)).not.toContain("fixture-new-credential");
    expect(JSON.stringify(result)).not.toContain(account.email!);
  } finally { reader.stop(); if (previous === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN; else process.env.CLAUDE_CODE_OAUTH_TOKEN = previous; }
});

test("timeouts retain prior values and late replies cannot replace them", async () => {
  let now = 100; const gate = deferred<unknown>(); let second = false;
  const fake = sdk(async () => second ? gate.promise : usage(20));
  const reader = new ClaudeAccountLimits(fake.open, { now: () => now, timeoutMs: 5 });
  await reader.read(); second = true; now += 6;
  const result = await reader.read({ refresh: true });
  expect(result).toMatchObject({ stale: true }); expect(result.windows[0]!.usedPercent).toBe(20);
  gate.resolve(usage(90)); await Promise.resolve(); await Promise.resolve();
  expect((await reader.read()).windows[0]!.usedPercent).toBe(20);
  expect(fake.calls.every(call => call.closed === 1)).toBe(true); reader.stop();
});

test("shutdown closes an in-flight account query and settles the read promptly", async () => {
  const gate = deferred<AccountInfo>(); const fake = sdk(undefined, () => gate.promise);
  const reader = new ClaudeAccountLimits(fake.open, { timeoutMs: 30_000 });
  const pending = reader.read(); reader.stop();
  await expect(pending).rejects.toThrow("stopped");
  expect(fake.calls[0]!.closed).toBe(1);
  gate.resolve(account); await Promise.resolve();
  await expect(reader.read()).rejects.toThrow("stopped");
});

test("an unsupported read without events does not fabricate a quota", async () => {
  const reader = new ClaudeAccountLimits(sdk(undefined, undefined, false).open);
  const result = await reader.read();
  expect(result.windows).toEqual([]); expect(result.availability).toBe("unavailable"); reader.stop();
  expect(emptyClaudeLimits(account).windows).toEqual([]);
});

test("a newer extra usage event survives a concurrent usage read and ages independently", async () => {
  let now = 100;
  const gate = deferred<unknown>(); const fake = sdk(() => gate.promise);
  const reader = new ClaudeAccountLimits(fake.open, { now: () => now, cacheSeconds: 1000, staleSeconds: 120 });
  const pending = reader.read(); await Promise.resolve();
  reader.observe({ status: "allowed", rateLimitType: "five_hour", overageEnabled: true, overageInUse: true }, account, reader.scope());
  gate.resolve(usage());
  expect((await pending).extraUsage).toMatchObject({ enabled: true, active: true, observedAt: 100, stale: false });
  now = 221;
  reader.observe({ status: "allowed", rateLimitType: "five_hour" }, account, reader.scope());
  expect((await reader.read()).extraUsage!.stale).toBe(true);
  reader.stop();
});

test("an event refreshes only its window after a failed full account refresh", async () => {
  let fail = false; let now = 100;
  const fake = sdk(async () => { if (fail) throw new Error('unavailable'); return usage(); });
  const reader = new ClaudeAccountLimits(fake.open, { now: () => now });
  await reader.read(); now = 106; fail = true;
  await reader.read({ refresh: true });
  reader.observe({ status: "allowed", rateLimitType: "five_hour", utilization: 0.2 }, account, reader.scope());
  const result = await reader.read();
  expect(result.windows.find(window => window.id === "five_hour")).toMatchObject({ stale: false, usedPercent: 20 });
  expect(result.windows.find(window => window.id === "seven_day")!.stale).toBe(true);
  expect(result.extraUsage!.stale).toBe(true);
  reader.stop();
});
