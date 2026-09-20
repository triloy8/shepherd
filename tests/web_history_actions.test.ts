import { expect, test } from "bun:test";
import { webHarness } from "./helpers/web_harness";

function harness() {
  const h = webHarness();
  Object.assign(h.application, { getSurfaceThreadId: (id: string) => h.bindings.get(id) ?? null });
  Object.assign(h.application.conversation, {
    async compactThread(id: string) { h.calls.push(`compact:${id}`); return { ok: true }; },
    async rollbackThread(id: string, request: { numTurns: number }) { h.calls.push(`rollback:${id}:${request.numTurns}`); return { thread: {} }; },
  });
  return h;
}

test("compact and rollback use shared actions; rollback revises history and notifies clients", async () => {
  const h = harness();
  try {
    const c = await h.create(); const path = `/conversations/${c.id}`;
    expect((await (await h.request(`${path}/turns`)).json()).revision).toBe(0);
    const stream = await h.request(`${path}/events`); const reader = stream.body!.getReader(); await reader.read();
    expect((await h.request(`${path}/compact`, "POST", {})).status).toBe(200);
    expect(h.calls).toContain(`compact:${c.threadId}`);
    expect((await h.request(`${path}/rollback`, "POST", { numTurns: 2 })).status).toBe(200);
    expect(h.calls).toContain(`rollback:${c.threadId}:2`);
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"reason":"history_changed"');
    expect((await (await h.request(`${path}/turns`)).json()).revision).toBe(1);
    await reader.cancel();
  } finally { h.api.dispose(); }
});

test("history actions validate counts and boundaries and reject active turns or approvals", async () => {
  const h = harness();
  try {
    const c = await h.create(); const path = `/conversations/${c.id}`;
    for (const numTurns of [0, -1, 1.5, "1", null, Number.MAX_SAFE_INTEGER + 1]) expect((await h.request(`${path}/rollback`, "POST", { numTurns })).status).toBe(400);
    expect((await h.request(`${path}/rollback`, "POST", {})).status).toBe(400);
    expect((await h.request(`${path}/compact`, "POST", { threadId: "other" })).status).toBe(400);
    expect((await h.request(`${path}/rollback`, "POST", { numTurns: 1, threadId: "other" })).status).toBe(400);
    expect((await h.request(`${path}/compact`, "POST", {}, { origin: "https://evil.test" })).status).toBe(403);
    h.active.set(c.threadId, "running");
    for (const action of ["compact", "rollback"]) expect((await h.request(`${path}/${action}`, "POST", action === "rollback" ? { numTurns: 1 } : {})).status).toBe(409);
    h.active.set(c.threadId, null);
    h.approvals.create({ approvalId: "approval", method: "test", prompt: "Allow?", choices: [{ value: "accept", label: "Allow" }], params: {} }, { threadId: c.threadId, sessionId: "session" });
    for (const action of ["compact", "rollback"]) expect((await h.request(`${path}/${action}`, "POST", action === "rollback" ? { numTurns: 1 } : {})).status).toBe(409);
    expect(h.calls.some((call) => /^(compact|rollback):/.test(call))).toBe(false);
    expect((await h.request("/conversations/missing/compact", "POST", {})).status).toBe(404);
  } finally { h.api.dispose(); }
});

test("rollback blocks concurrent writes and invalidates snapshots begun before completion", async () => {
  const h = harness(); let release!: () => void; let historyRelease!: () => void;
  Object.assign(h.application.conversation, { rollbackThread: async () => { await new Promise<void>((resolve) => { release = resolve; }); return { thread: {} }; } });
  try {
    const c = await h.create(); const path = `/conversations/${c.id}`;
    h.application.conversation.listThreadTurns = async () => { await new Promise<void>((resolve) => { historyRelease = resolve; }); return { data: [], nextCursor: null, backwardsCursor: null }; };
    const stale = h.request(`${path}/turns`);
    while (!historyRelease) await new Promise((resolve) => setTimeout(resolve, 1));
    const pending = h.request(`${path}/rollback`, "POST", { numTurns: 1 });
    while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
    expect((await h.request(`${path}/compact`, "POST", {})).status).toBe(409);
    expect((await h.request(`${path}/messages`, "POST", { text: "hello" })).status).toBe(409);
    release(); expect((await pending).status).toBe(200);
    historyRelease(); expect((await stale).status).toBe(409);
  } finally { release?.(); historyRelease?.(); h.api.dispose(); }
});

test("failed rollback preserves attachment, releases lock, and forces authoritative history recovery", async () => {
  const h = harness();
  Object.assign(h.application.conversation, { rollbackThread: async () => { throw new Error("private failure"); } });
  try {
    const c = await h.create(); const path = `/conversations/${c.id}`;
    const response = await h.request(`${path}/rollback`, "POST", { numTurns: 1 });
    expect(response.status).toBe(502); expect(await response.text()).not.toContain("private failure");
    expect((await (await h.request(`${path}/turns`)).json()).revision).toBe(1);
    expect(h.bindings.get(c.id)).toBe(c.threadId);
    expect((await h.request(`${path}/compact`, "POST", {})).status).toBe(200);
  } finally { h.api.dispose(); }
});
