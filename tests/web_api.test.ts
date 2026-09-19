import { expect, test } from "bun:test";
import { webHarness, WEB_TEST_TOKEN } from "./helpers/web_harness.js";
import { readWebConfig } from "../server/adapters/web/config.js";

test("web configuration requires a token, exact safe origins and a valid port", () => {
  for (const token of [undefined, "short", "a b".repeat(20), "a".repeat(257)]) {
    expect(() => readWebConfig({ SHEPHERD_WEB_TOKEN: token })).toThrow("TOKEN");
  }
  for (const origin of ["*", "null", "http://remote.test", "https://site.test/path", "https://user:pass@site.test", "https://*.test"]) {
    expect(() => readWebConfig({ SHEPHERD_WEB_TOKEN: WEB_TEST_TOKEN, SHEPHERD_WEB_ORIGINS: origin })).toThrow("ORIGINS");
  }
  for (const port of ["0", "65536", "no", "1.5"]) expect(() => readWebConfig({ SHEPHERD_WEB_TOKEN: WEB_TEST_TOKEN, SHEPHERD_WEB_PORT: port })).toThrow("PORT");
  expect(readWebConfig({ SHEPHERD_WEB_TOKEN: WEB_TEST_TOKEN, SHEPHERD_WEB_ORIGINS: "http://localhost:3000" })).toMatchObject({ hostname: "127.0.0.1", port: 8788 });
});

test("all data and health routes require header authentication, never query/cookie tokens", async () => {
  const h = webHarness();
  try {
    for (const path of ["/health", "/threads", "/conversations", `/health?token=${WEB_TEST_TOKEN}`]) {
      const r = await h.request(path, "GET", undefined, { authorization: "", cookie: `token=${WEB_TEST_TOKEN}` });
      expect(r.status).toBe(401); expect(r.headers.get("cache-control")).toBe("no-store");
    }
    expect((await h.request("/conversations", "POST", { project: "~" }, { authorization: "Bearer wrong" })).status).toBe(401);
    expect(h.calls).toEqual([]);
    expect(await (await h.request("/health")).json()).toEqual({ ok: true, apiVersion: 1 });
  } finally { h.api.dispose(); }
});

test("browser origin and preflight rules reject unapproved cross-origin access", async () => {
  const h = webHarness();
  try {
    expect((await h.request("/health", "GET", undefined, { origin: "https://evil.test" })).status).toBe(403);
    const allowed = await h.request("/health", "GET", undefined, { origin: "https://ui.example.test" });
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://ui.example.test");
    expect(allowed.headers.has("access-control-allow-credentials")).toBe(false);
    const preflight = await h.request("/conversations", "OPTIONS", undefined, { authorization: "", origin: "https://ui.example.test", "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" });
    expect(preflight.status).toBe(204);
    expect((await h.request("/conversations", "OPTIONS", undefined, { origin: "https://ui.example.test", "access-control-request-method": "POST", "access-control-request-headers": "x-unsupported" })).status).toBe(403);
  } finally { h.api.dispose(); }
});

test("create, resume, list, send/steer, history, interrupt and detach use shared ports", async () => {
  const h = webHarness();
  try {
    const conversation = await h.create();
    const path = `/conversations/${conversation.id}`;
    expect((await (await h.request("/conversations")).json()).conversations).toEqual([conversation]);
    expect((await (await h.request(path)).json()).state.threadId).toBe(conversation.threadId);
    expect((await (await h.request(`${path}/messages`, "POST", { text: "hello" })).json()).type).toBe("submit");
    expect((await (await h.request(`${path}/messages`, "POST", { text: "follow up" })).json()).type).toBe("steer");
    expect((await h.request(`${path}/interrupt`, "POST", {})).status).toBe(200);
    expect(h.active.get(conversation.threadId)).toBeNull();
    expect((await h.request(`${path}/turns?limit=10`)).status).toBe(200);
    expect((await h.request("/threads?limit=10")).status).toBe(200);
    expect((await h.request(path, "DELETE")).status).toBe(200);
    expect((await h.request(path)).status).toBe(404);
    expect(h.bindings.size).toBe(0);
    expect((await h.create({ project: "~", threadId: "stored" })).threadId).toBe("stored");
    expect(h.calls).toContain("resume");
  } finally { h.api.dispose(); }
});

test("exclusive thread conflicts clean provisional web state", async () => {
  const h = webHarness();
  try {
    const response = await h.request("/conversations", "POST", { project: "~", threadId: "discord-thread" });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("thread_in_use");
    expect((await (await h.request("/conversations")).json()).conversations).toEqual([]);
    expect(h.calls.some((s) => s.startsWith("dispose:"))).toBe(true);
  } finally { h.api.dispose(); }
});

test("approval choices are validated without consuming invalid requests; duplicate decisions conflict", async () => {
  const h = webHarness();
  try {
    const c = await h.create(); const path = `/conversations/${c.id}/approvals`;
    h.approvals.create({ approvalId: "approval:1", method: "test", prompt: "Allow?", choices: [{ value: "accept", label: "Accept" }], params: {} }, { threadId: c.threadId, sessionId: "session" });
    expect((await (await h.request(path)).json()).approvals[0].status).toBe("pending");
    expect((await h.request(`${path}/approval%3A1`, "POST", { decision: "bogus" })).status).toBe(400);
    expect(h.approvals.listByThread(c.threadId)[0]!.status).toBe("pending");
    expect((await h.request(`${path}/approval%3A1`, "POST", { decision: "accept" })).status).toBe(200);
    expect((await h.request(`${path}/approval%3A1`, "POST", { decision: "accept" })).status).toBe(409);
    expect((await h.request(`${path}/unknown`, "POST", { decision: "accept" })).status).toBe(404);
  } finally { h.api.dispose(); }
});

test("malformed requests and oversized bodies never invoke conversation creation", async () => {
  const h = webHarness();
  try {
    for (const data of [null, [], {}, { project: "" }, { project: "~", sandbox: "danger-full-access" }, { project: "~", threadId: "../../escape" }]) {
      expect((await h.request("/conversations", "POST", data)).status).toBe(400);
    }
    expect((await h.request("/conversations", "POST", { project: "~" }, { "content-type": "text/plain" })).status).toBe(415);
    expect((await h.request("/conversations", "POST", { project: "x".repeat(70_000) })).status).toBe(413);
    const invalid = await h.api.fetch(new Request("http://localhost/api/v1/conversations", { method: "POST", headers: { authorization: `Bearer ${WEB_TEST_TOKEN}`, "content-type": "application/json" }, body: "{" }));
    expect(invalid.status).toBe(400);
    expect(h.calls).toEqual([]);
    expect((await h.request("/threads?limit=101")).status).toBe(400);
  } finally { h.api.dispose(); }
});

test("simultaneous mutations conflict rather than duplicating a turn", async () => {
  const h = webHarness();
  try {
    const c = await h.create();
    let release!: () => void; let entered!: () => void;
    const entry = new Promise<void>((resolve) => { entered = resolve; });
    h.context.ingress.submitTurn = async () => { entered(); await new Promise<void>((resolve) => { release = resolve; }); return { ok: true, turnId: "turn" }; };
    const first = h.request(`/conversations/${c.id}/messages`, "POST", { text: "one" });
    await entry;
    expect((await h.request(`/conversations/${c.id}/messages`, "POST", { text: "two" })).status).toBe(409);
    release(); expect((await first).status).toBe(200);
  } finally { h.api.dispose(); }
});

test("shutdown during project preparation does not create a thread or retain navigation state", async () => {
  const h = webHarness();
  let release!: () => void; let entered!: () => void;
  const entry = new Promise<void>((resolve) => { entered = resolve; });
  h.application.setSurfaceProject = async () => { entered(); await new Promise<void>((resolve) => { release = resolve; }); return { repoSlug: "~" }; };
  const pending = h.request("/conversations", "POST", { project: "~" });
  await entry;
  h.abort.abort(); h.api.dispose(); release();
  expect((await pending).status).toBe(503);
  expect(h.calls).not.toContain("create");
  expect(h.bindings.size).toBe(0);
});

test("conversation navigation is bounded and slots are released on detach", async () => {
  const h = webHarness();
  try {
    const first = await h.create();
    for (let i = 1; i < 32; i++) await h.create();
    expect((await h.request("/conversations", "POST", { project: "~" })).status).toBe(429);
    await h.request(`/conversations/${first.id}`, "DELETE");
    expect((await h.request("/conversations", "POST", { project: "~" })).status).toBe(201);
  } finally { h.api.dispose(); }
});

test("cleanup attempts every conversation even when one binding release fails", async () => {
  const h = webHarness();
  const first = await h.create();
  const second = await h.create();
  const released: string[] = [];
  const dispose = h.application.disposeSurface;
  h.application.disposeSurface = (id) => {
    released.push(id);
    dispose(id);
    if (id === first.id) throw new Error("release failed");
  };
  expect(() => h.api.dispose()).toThrow("cleanup failed");
  expect(released).toEqual([first.id, second.id]);
  expect(h.bindings.size).toBe(0);
  h.api.dispose();
});
