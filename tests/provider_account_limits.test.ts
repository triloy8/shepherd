import { expect, test } from "bun:test";
import { ConversationService } from "../server/core/conversation_service.js";
import { createApplicationConversation } from "../server/core/conversation_ports.js";
import { memoryProviderDirectory, missingSessionFactory } from "../server/core/agent_provider.js";
import { AccountLimitsService } from "../server/core/account_limits_service.js";
import { emptyClaudeLimits } from "../server/providers/claude/account_limits_mapper.js";
import { webHarness } from "./helpers/web_harness.js";
import { installWebSettings } from "./helpers/web_settings_harness.js";

const snapshot = () => emptyClaudeLimits({ subscriptionType: "pro" });

test("account readers run without a conversation and enforce provider identity and shutdown", async () => {
  let stopped = 0;
  const calls: unknown[] = [];
  const reader = { async read(options?: unknown) { calls.push(options); return snapshot(); }, stop() { stopped++; } };
  const service = new AccountLimitsService({ claude: reader });
  expect(await service.read("claude", { refresh: true })).toEqual(snapshot());
  expect(calls).toEqual([{ refresh: true }]);
  expect(service.read("codex")).rejects.toThrow("account allowance reporting");
  const invalid = new AccountLimitsService({ codex: reader });
  expect(invalid.read("codex")).rejects.toThrow("another provider");
  service.stop(); service.stop();
  expect(stopped).toBe(1);
  expect(service.read("claude")).rejects.toThrow("stopped");
});

test("web Claude limits are host account data and preserve the legacy Codex response", async () => {
  const h = webHarness(); installWebSettings(h);
  const calls: unknown[] = [];
  Object.assign(h.application.conversation, { async readProviderAccountLimits(provider: string, options?: unknown) {
    calls.push({ provider, options }); return snapshot();
  } });
  try {
    expect(await (await h.request("/limits?provider=claude&refresh=true")).json()).toEqual(snapshot());
    expect(calls).toEqual([{ provider: "claude", options: { refresh: true } }]);
    for (const path of ["/limits", "/limits?provider=codex"]) {
      const response = await h.request(path);
      expect(response.status).toBe(200);
      expect((await response.json()).rateLimits.primary.usedPercent).toBe(25);
    }
    for (const query of ["provider=unknown", "provider=claude&refresh=1", "provider=claude&extra=x", "provider=claude&provider=codex", "refresh=true&refresh=false"]) {
      expect((await h.request(`/limits?${query}`)).status).toBe(400);
    }
    expect((await h.request("/limits?provider=claude", "GET", undefined, { origin: "https://evil.test" })).status).toBe(403);
    expect(calls).toHaveLength(1);
    expect(h.active.size).toBe(0);
  } finally { h.api.dispose(); }
});

test("Claude refresh cannot redeem a Codex reset and native failures stay private", async () => {
  const h = webHarness(); installWebSettings(h);
  let resets = 0;
  Object.assign(h.application.conversation, {
    async consumeRateLimitReset() { resets++; return { outcome: "reset" }; },
    async readProviderAccountLimits() { throw new Error("private fixture credential"); },
  });
  try {
    const response = await h.request("/limits/reset?provider=claude", "POST", { idempotencyKey: "test" });
    expect(response.status).toBe(400); expect(resets).toBe(0);
    const failed = await h.request("/limits?provider=claude");
    expect(failed.status).toBe(502);
    expect(JSON.stringify(await failed.json())).not.toContain("private fixture credential");
  } finally { h.api.dispose(); }
});


test("the production surface capability exposes host account reads and closes their reader", async () => {
  let stopped = 0;
  const service = new ConversationService({ providers: {
    providers: ["codex", "claude"], directory: memoryProviderDirectory(),
    createSession: missingSessionFactory, hasStoredThreads: () => false,
    accountLimits: { claude: { read: async () => snapshot(), stop() { stopped++; } } },
  } });
  const h = webHarness();
  Object.assign(h.application, { conversation: createApplicationConversation(service) });
  try {
    const response = await h.request("/limits?provider=claude");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(snapshot());
  } finally { h.api.dispose(); service.stopAll(); }
  expect(stopped).toBe(1);
});
