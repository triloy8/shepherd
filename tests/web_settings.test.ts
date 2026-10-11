import { account } from "./helpers/account";
import { expect, test } from "bun:test";
import { webHarness } from "./helpers/web_harness";
import { installWebSettings } from "./helpers/web_settings_harness";

test("web settings use shared model resolution across pages and pending effort semantics", async () => {
  const h = webHarness(); installWebSettings(h);
  try {
    const c = await h.create(); const path = `/conversations/${c.id}`;
    const first = await (await h.request(`${path}/models?limit=1`)).json();
    expect(first.nextCursor).toBe("next");
    expect((await (await h.request(`${path}/models?cursor=next`)).json()).data[0].id).toBe("large");
    expect((await h.request(`${path}/model`, "POST", { model: "LARGE" })).status).toBe(200);
    const settings = await (await h.request(`${path}/settings`)).json();
    expect(settings.model.currentModel).toBe("small"); expect(settings.model.pendingModel).toBe("large");
    expect(settings.effort.supportedEfforts.map((e: { value: string }) => e.value)).toEqual(["low", "high"]);
    expect((await h.request(`${path}/effort`, "POST", { effort: "high" })).status).toBe(200);
    expect((await (await h.request(`${path}/settings`)).json()).effort.pendingEffort).toBe("high");
    expect((await h.request(`${path}/effort`, "POST", { effort: "default" })).status).toBe(200);
    expect((await (await h.request(`${path}/settings`)).json()).effort.pendingEffort).toBe("low");
    expect((await (await h.request(`${path}/context`)).json()).tokenUsage).toBeNull();
    expect((await (await h.request("/limits")).json()).windows[0].usedPercent).toBe(25);
  } finally { h.api.dispose(); }
});

test("settings reject invalid inputs and respect conversation and origin boundaries", async () => {
  const h = webHarness(); installWebSettings(h);
  try {
    const c = await h.create(); const path = `/conversations/${c.id}`;
    for (const [route, data] of [["model", { model: "unknown" }], ["effort", { effort: "high" }], ["model", { model: "small", extra: true }], ["effort", { effort: "" }]] as const) expect((await h.request(`${path}/${route}`, "POST", data)).status).toBe(400);
    expect((await h.request(`${path}/model`, "POST", { model: "large" }, { origin: "https://evil.test" })).status).toBe(403);
    expect((await h.request("/conversations/missing/settings")).status).toBe(404);
    expect((await h.request(`${path}/models?limit=999`)).status).toBe(400);
    await h.request(path, "DELETE");
    expect((await h.request(`${path}/effort`, "POST", { effort: "low" })).status).toBe(404);
  } finally { h.api.dispose(); }
});

test("a pending settings change shares the existing conversation mutation lock", async () => {
  const h = webHarness(); installWebSettings(h);
  let release!: () => void;
  Object.assign(h.application.conversation, { listModels: async () => { await new Promise<void>((resolve) => { release = resolve; }); return { data: [{ id: "large", model: "large" }], nextCursor: null }; } });
  try {
    const c = await h.create(); const path = `/conversations/${c.id}`;
    const pending = h.request(`${path}/model`, "POST", { model: "large" });
    while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
    expect((await h.request(`${path}/effort`, "POST", { effort: "low" })).status).toBe(409);
    release(); expect((await pending).status).toBe(200);
  } finally { release?.(); h.api.dispose(); }
});

test("account usage and idempotent resets use the same provider boundary without a conversation", async () => {
  const h = webHarness(); installWebSettings(h);
  const limits = account(); limits.resets = { supported: true, availableCount: 2, credits: [{ id: "reset-1", supported: true, status: "available", grantedAt: 100, expiresAt: 200, title: "Reset", description: null }] };
  const requests: unknown[] = [], seen = new Set<string>();
  const descriptors = h.application.conversation.listProviders(); descriptors[0]!.capabilities.resets = true;
  Object.assign(h.application.conversation, {
    listProviders: () => descriptors,
    async readAccount() { return limits; },
    async resetAccount(provider: string, request: { idempotencyKey: string; creditId?: string }) {
      expect(provider).toBe("fixture"); requests.push(request);
      if (seen.has(request.idempotencyKey)) return { outcome: "already_redeemed" };
      seen.add(request.idempotencyKey); limits.resets.availableCount!--; return { outcome: "reset" };
    },
  });
  try {
    expect(await (await h.request("/limits?provider=fixture")).json()).toMatchObject({ provider: "fixture", resets: limits.resets });
    const input = { provider: "fixture", idempotencyKey: "same-attempt", creditId: "reset-1" };
    expect(await (await h.request("/limits/reset", "POST", input)).json()).toEqual({ outcome: "reset" });
    expect(await (await h.request("/limits/reset", "POST", input)).json()).toEqual({ outcome: "already_redeemed" });
    expect(requests).toEqual([1, 2].map(() => ({ idempotencyKey: input.idempotencyKey, creditId: input.creditId })));
    expect((await (await h.request("/limits")).json()).resets.availableCount).toBe(1);
    for (const data of [{}, { idempotencyKey: "" }, { idempotencyKey: "a", creditId: "" }, { idempotencyKey: "a", creditId: null }, { idempotencyKey: "a", extra: true }, { idempotencyKey: "a".repeat(101) }]) expect((await h.request("/limits/reset", "POST", { provider: "fixture", ...data })).status).toBe(400);
    expect((await h.request("/limits/reset", "POST", input, { origin: "https://evil.test" })).status).toBe(403);
    expect(requests).toHaveLength(2);
    Object.assign(h.application.conversation, { async resetAccount() { throw new Error("private provider details"); } });
    const failed = await h.request("/limits/reset", "POST", input);
    expect(failed.status).toBe(502); expect(JSON.stringify(await failed.json())).not.toContain("private provider details");
  } finally { h.api.dispose(); }
});

test("account model metadata is paginated, includes hidden aliases, and needs no conversation", async () => {
  const h = webHarness(); installWebSettings(h);
  const calls: unknown[] = [];
  Object.assign(h.application.conversation, { async listModels(request: { cursor?: string }) {
    calls.push(request);
    return { data: [{ id: "future", model: "future-model", displayName: "Future Model", hidden: true }], nextCursor: request.cursor ? null : "page-2" };
  } });
  try {
    expect((await (await h.request("/models?limit=100")).json()).nextCursor).toBe("page-2");
    expect((await (await h.request("/models?cursor=page-2&limit=100")).json()).data[0].displayName).toBe("Future Model");
    expect(calls).toEqual([{ limit: 100, includeHidden: true }, { limit: 100, cursor: "page-2", includeHidden: true }]);
    for (const route of ["/models?limit=0", "/models?limit=101", "/models?extra=true"]) expect((await h.request(route)).status).toBe(400);
    expect((await h.request("/models", "GET", undefined, { origin: "https://evil.test" })).status).toBe(403);
    expect(calls).toHaveLength(2);
  } finally { h.api.dispose(); }
});
