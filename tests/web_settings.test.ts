import { expect, test } from "bun:test";
import { webHarness } from "./helpers/web_harness";
import { installWebSettings } from "./helpers/web_settings_harness";

test("web settings use shared model resolution across pages and pending effort semantics", async () => {
  const h = webHarness(); installWebSettings(h);
  try {
    const c = await h.create(); const path = `/conversations/${c.id}`;
    const first = await (await h.request(`${path}/models?limit=1`)).json();
    expect(first.nextCursor).toBe("next");
    expect((await (await h.request(`${path}/models?cursor=next`)).json()).data[0].model).toBe("large");
    expect((await h.request(`${path}/model`, "POST", { model: "LARGE" })).status).toBe(200);
    const settings = await (await h.request(`${path}/settings`)).json();
    expect(settings.model.currentModel).toBe("small"); expect(settings.model.pendingModel).toBe("large");
    expect(settings.effort.supportedEfforts.map((e: { reasoningEffort: string }) => e.reasoningEffort)).toEqual(["low", "high"]);
    expect((await h.request(`${path}/effort`, "POST", { effort: "high" })).status).toBe(200);
    expect((await (await h.request(`${path}/settings`)).json()).effort.pendingEffort).toBe("high");
    expect((await h.request(`${path}/effort`, "POST", { effort: "default" })).status).toBe(200);
    expect((await (await h.request(`${path}/settings`)).json()).effort.pendingEffort).toBe("low");
    expect((await (await h.request(`${path}/context`)).json()).tokenUsage).toBeNull();
    expect((await (await h.request("/limits")).json()).rateLimits.primary.usedPercent).toBe(25);
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
