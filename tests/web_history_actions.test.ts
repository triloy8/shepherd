import { expect, test } from "bun:test";
import { webHarness } from "./helpers/web_harness";

function harness() {
  const h = webHarness();
  Object.assign(h.application, { getSurfaceThreadId: (id: string) => h.bindings.get(id) ?? null });
  Object.assign(h.application.conversation, {
    async compactThread(id: string) { h.calls.push(`compact:${id}`); return { ok: true }; },
    async revertThread(id: string, request: { beforeTurnId: string }) { h.calls.push(`revert:${id}:${request.beforeTurnId}`); return { thread: {} }; },
  });
  return h;
}

test("compact and revert use shared actions; revert revises history and notifies clients", async () => {
  const h = harness();
  try {
    const c = await h.create(); const path = `/conversations/${c.id}`;
    expect((await (await h.request(`${path}/turns`)).json()).revision).toBe(0);
    const stream = await h.request(`${path}/events`); const reader = stream.body!.getReader(); await reader.read();
    expect((await h.request(`${path}/compact`, "POST", {})).status).toBe(200);
    expect(h.calls).toContain(`compact:${c.threadId}`);
    expect((await h.request(`${path}/revert`, "POST", { beforeTurnId: "turn-2" })).status).toBe(200);
    expect(h.calls).toContain(`revert:${c.threadId}:turn-2`);
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"reason":"history_changed"');
    expect((await (await h.request(`${path}/turns`)).json()).revision).toBe(1);
    await reader.cancel();
  } finally { h.api.dispose(); }
});

test("history actions validate turn IDs and boundaries and reject active turns or approvals", async () => {
  const h = harness();
  try {
    const c = await h.create(); const path = `/conversations/${c.id}`;
    for (const beforeTurnId of [0, null, "", " ", "x".repeat(257), {}, []]) expect((await h.request(`${path}/revert`, "POST", { beforeTurnId })).status).toBe(400);
    expect((await h.request(`${path}/revert`, "POST", {})).status).toBe(400);
    expect((await h.request(`${path}/compact`, "POST", { threadId: "other" })).status).toBe(400);
    expect((await h.request(`${path}/revert`, "POST", { beforeTurnId: "turn-1", threadId: "other" })).status).toBe(400);
    expect((await h.request(`${path}/compact`, "POST", {}, { origin: "https://evil.test" })).status).toBe(403);
    h.active.set(c.threadId, "running");
    for (const action of ["compact", "revert"]) expect((await h.request(`${path}/${action}`, "POST", action === "revert" ? { beforeTurnId: "turn-1" } : {})).status).toBe(409);
    h.active.set(c.threadId, null);
    h.approvals.create({ approvalId: "approval", method: "test", prompt: "Allow?", choices: [{ value: "accept", label: "Allow" }], params: {} }, { threadId: c.threadId, sessionId: "session" });
    for (const action of ["compact", "revert"]) expect((await h.request(`${path}/${action}`, "POST", action === "revert" ? { beforeTurnId: "turn-1" } : {})).status).toBe(409);
    expect(h.calls.some((call) => /^(compact|revert):/.test(call))).toBe(false);
    expect((await h.request("/conversations/missing/compact", "POST", {})).status).toBe(404);
  } finally { h.api.dispose(); }
});

test("revert blocks concurrent writes and invalidates snapshots begun before completion", async () => {
  const h = harness(); let release!: () => void; let historyRelease!: () => void;
  Object.assign(h.application.conversation, { revertThread: async () => { await new Promise<void>((resolve) => { release = resolve; }); return { thread: {} }; } });
  try {
    const c = await h.create(); const path = `/conversations/${c.id}`;
    h.application.conversation.listThreadTurns = async () => { await new Promise<void>((resolve) => { historyRelease = resolve; }); return { data: [], nextCursor: null, backwardsCursor: null }; };
    const stale = h.request(`${path}/turns`);
    while (!historyRelease) await new Promise((resolve) => setTimeout(resolve, 1));
    const pending = h.request(`${path}/revert`, "POST", { beforeTurnId: "turn-1" });
    while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
    expect((await h.request(`${path}/compact`, "POST", {})).status).toBe(409);
    expect((await h.request(`${path}/messages`, "POST", { text: "hello" })).status).toBe(409);
    release(); expect((await pending).status).toBe(200);
    historyRelease(); expect((await stale).status).toBe(409);
  } finally { release?.(); historyRelease?.(); h.api.dispose(); }
});

test("failed revert preserves attachment, releases lock, and forces authoritative history recovery", async () => {
  const h = harness();
  Object.assign(h.application.conversation, { revertThread: async () => { throw new Error("private failure"); } });
  try {
    const c = await h.create(); const path = `/conversations/${c.id}`;
    const response = await h.request(`${path}/revert`, "POST", { beforeTurnId: "turn-1" });
    expect(response.status).toBe(502); expect(await response.text()).not.toContain("private failure");
    expect((await (await h.request(`${path}/turns`)).json()).revision).toBe(1);
    expect(h.bindings.get(c.id)).toBe(c.threadId);
    expect((await h.request(`${path}/compact`, "POST", {})).status).toBe(200);
  } finally { h.api.dispose(); }
});


test("provider revert invalidates all connected clients and does not duplicate the initiating reset", async () => {
  const h = harness();
  try {
    const c = await h.create(); const path = `/conversations/${c.id}`;
    const readers = await Promise.all([1, 2].map(async () => { const response = await h.request(`${path}/events`); const reader = response.body!.getReader(); await reader.read(); return reader; }));
    const notify = () => h.publish(c.id, { id: "reverted-1", type: "thread.reverted", threadId: c.threadId, sessionId: "session", ts: new Date().toISOString(), payload: {} });
    Object.assign(h.application.conversation, { revertThread: async () => { notify(); return { thread: {} }; } });
    expect((await h.request(`${path}/revert`, "POST", { beforeTurnId: "turn" })).status).toBe(200);
    for (const reader of readers) expect(new TextDecoder().decode((await reader.read()).value)).toContain('"history_changed"');
    expect((await (await h.request(`${path}/turns`)).json()).revision).toBe(1);
    notify();
    expect((await (await h.request(`${path}/turns`)).json()).revision).toBe(2);
    for (const reader of readers) await reader.cancel();
    expect((await h.request(`${path}/rollback`, "POST", { numTurns: 1 })).status).toBe(404);
  } finally { h.api.dispose(); }
});
