import { expect, test } from "bun:test";
import { webHarness } from "./helpers/web_harness";

function harness() {
  const h = webHarness();
  Object.assign(h.application, {
    getSurfaceThreadId: (id: string) => h.bindings.get(id) ?? null,
    clearSurfaceThread: (id: string) => h.bindings.delete(id),
    async forkSurfaceThread(id: string, source: string) { h.calls.push(`fork:${source}`); h.bindings.set(id, "forked"); return "forked"; },
  });
  Object.assign(h.application.conversation, {
    async setThreadName(id: string, { name }: { name: string }) { h.calls.push(`rename:${id}:${name}`); return { ok: true }; },
    async archiveThread(id: string) { h.calls.push(`archive:${id}`); return { ok: true }; },
    async unarchiveThread(id: string) { h.calls.push(`restore:${id}`); return { ok: true }; },
  });
  return h;
}

test("rename, archive and restore use shared actions and archive removes the web handle", async () => {
  const h = harness();
  try {
    const c = await h.create(); const path = `/conversations/${c.id}`;
    expect((await h.request(`${path}/rename`, "POST", { name: "  New name  " })).status).toBe(200);
    expect(h.calls).toContain(`rename:${c.threadId}:New name`);
    expect((await h.request(`${path}/archive`, "POST", {})).status).toBe(200);
    expect(h.bindings.has(c.id)).toBe(false);
    expect((await h.request(path)).status).toBe(404);
    expect((await h.request(`/threads/${c.threadId}/unarchive`, "POST", {})).status).toBe(200);
    expect(h.calls).toContain(`restore:${c.threadId}`);
  } finally { h.api.dispose(); }
});

test("fork returns a new handle and preserves the source binding and project", async () => {
  const h = harness();
  try {
    const c = await h.create({ project: "~/project" });
    const response = await h.request(`/conversations/${c.id}/fork`, "POST", {});
    expect(response.status).toBe(201);
    const fork = await response.json(); expect(fork.id).not.toBe(c.id); expect(fork.threadId).toBe("forked"); expect(fork.project).toBe(c.project);
    expect(h.bindings.get(c.id)).toBe(c.threadId); expect(h.bindings.get(fork.id)).toBe("forked");
    expect(h.calls).toContain(`fork:${c.threadId}`);
  } finally { h.api.dispose(); }
});

test("active turns block fork/archive, while renaming remains available", async () => {
  const h = harness();
  try {
    const c = await h.create(); h.active.set(c.threadId, "turn"); const path = `/conversations/${c.id}`;
    for (const action of ["fork", "archive"]) expect((await h.request(`${path}/${action}`, "POST", {})).status).toBe(409);
    expect((await h.request(`${path}/rename`, "POST", { name: "Working" })).status).toBe(200);
    expect(h.bindings.get(c.id)).toBe(c.threadId);
  } finally { h.api.dispose(); }
});

test("management rejects malformed requests and disallowed origins", async () => {
  const h = harness();
  try {
    const c = await h.create(); const path = `/conversations/${c.id}`;
    for (const name of [" ", "x".repeat(201)]) expect((await h.request(`${path}/rename`, "POST", { name })).status).toBe(400);
    expect((await h.request(`${path}/fork`, "POST", { threadId: "other" })).status).toBe(400);
    expect((await h.request(`/threads/${c.threadId}/unarchive`, "POST", {}, { origin: "https://evil.test" })).status).toBe(403);
    expect((await h.request("/threads?archived=maybe")).status).toBe(400);
    expect((await h.request("/threads?archived=true&surprise=1")).status).toBe(400);
    let received: unknown;
    h.application.conversation.listStoredThreads = async (request) => { received = request; return { threads: [], nextCursor: null, backwardsCursor: null }; };
    await h.request("/threads?archived=true&cursor=next&limit=3"); expect(received).toEqual({ archived: true, cursor: "next", limit: 3, sortKey: "updated_at", sortDirection: "desc" });
  } finally { h.api.dispose(); }
});

test("failed fork removes provisional handle without detaching source", async () => {
  const h = harness();
  Object.assign(h.application, { async forkSurfaceThread() { throw new Error("Unavailable"); } });
  try {
    const c = await h.create();
    expect((await h.request(`/conversations/${c.id}/fork`, "POST", {})).status).toBe(502);
    const list = await (await h.request("/conversations")).json(); expect(list.conversations).toHaveLength(1); expect(h.bindings.get(c.id)).toBe(c.threadId);
  } finally { h.api.dispose(); }
});

test("pending approvals block archival even when no turn is marked active", async () => {
  const h = harness();
  try {
    const c = await h.create();
    h.approvals.create({ approvalId: "approval", method: "test", prompt: "Allow?", choices: [{ value: "accept", label: "Allow" }], params: {} }, { threadId: c.threadId, sessionId: "session" });
    expect((await h.request(`/conversations/${c.id}/archive`, "POST", {})).status).toBe(409);
    expect((await h.request(`/conversations/${c.id}/fork`, "POST", {})).status).toBe(409);
  } finally { h.api.dispose(); }
});

test("archive failure retains handle and binding for recovery", async () => {
  const h = harness();
  Object.assign(h.application.conversation, { async archiveThread() { throw new Error("Archive unavailable"); } });
  try {
    const c = await h.create();
    expect((await h.request(`/conversations/${c.id}/archive`, "POST", {})).status).toBe(502);
    expect((await h.request(`/conversations/${c.id}`)).status).toBe(200);
    expect(h.bindings.get(c.id)).toBe(c.threadId);
  } finally { h.api.dispose(); }
});
