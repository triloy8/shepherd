import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileSwarmStore } from "../server/storage/swarm_store.js";
import { SwarmService } from "../server/core/surface/swarm_service.js";
import { WebChatApi } from "../server/adapters/web/api.js";
import { createWebChatAdapter, createWebSurface } from "../server/adapters/web/server.js";
import { webHarness } from "./helpers/web_harness.js";
import type { SwarmGroup } from "../shared/protocol/swarm.js";
import type { SwarmStore } from "../server/ports/swarm_store.js";

function memoryStore(): SwarmStore {
  const groups = new Map<string, SwarmGroup>();
  return { list: () => structuredClone([...groups.values()]), read: id => structuredClone(groups.get(id) ?? null), save(group, revision) {
    if ((groups.get(group.id)?.revision ?? null) !== revision) throw new Error("revision conflict");
    groups.set(group.id, structuredClone(group));
  } };
}
function harness(store = memoryStore(), manager = false) {
  let handler: import("../server/ports/swarm_runtime.js").SwarmManagerHandler | undefined;
  let watchFails = false;
  let connected = false;
  const h = webHarness();
  const readState = h.context.ingress.getThreadState.bind(h.context.ingress);
  h.context.ingress.getThreadState = id => { if (!h.active.has(id)) throw new Error("Thread unavailable"); return readState(id); };
  Object.assign(h.application.conversation, {
    readThread: async (id: string) => { if (!h.active.has(id)) throw new Error("Thread not found"); return { thread: { id } }; },
    getThreadState: (id: string) => { if (!h.active.has(id)) throw new Error("Thread unavailable"); return h.context.ingress.getThreadState(id); },
  });
  if (manager) h.context.swarmManager = {
    connect: fn => { handler = fn; connected = true; return () => { connected = false; }; },
    watch: async (_params, _group, threads) => { h.calls.push(`watch:${threads.map(t => t.threadId).join(",")}`); return { success: !watchFails, contentItems: [{ type: "text", text: watchFails ? "watch unavailable" : "watching" }] }; },
  };
  const api = new WebChatApi(h.context, h.config, store);
  const request = (path: string, method = "GET", data?: unknown, headers: Record<string, string> = {}) => api.fetch(new Request(`http://127.0.0.1/api${path}`, {
    method, headers: { ...(data === undefined ? {} : { "content-type": "application/json" }), ...headers }, ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  }));
  const create = async () => {
    const response = await request("/swarms", "POST", { name: "Inbox", project: "owner/repo", strategy: "split" });
    expect(response.status).toBe(201); return (await response.json()).group as SwarmGroup;
  };
  const dispose = () => { api.dispose(); h.api.dispose(); };
  return { ...h, api, request, create, dispose, store,
    connected: () => connected, failWatch: (value: boolean) => { watchFails = value; },
    manage: (threadId: string, tool: string, args: import("../shared/protocol/dynamic_tools.js").JsonValue = {}, turnId = "manager-turn") => handler!({ threadId, turnId, callId: crypto.randomUUID(), namespace: "shepherd", tool, arguments: args }),
  };
}

test("group creation and membership are explicit and never start turns", async () => {
  const h = harness();
  try {
    let group = await h.create();
    expect(group.members).toEqual([]);
    const add = await h.request(`/swarms/${group.id}/members`, "POST", { revision: 1, name: "Solu", assignment: "Review layout" });
    expect(add.status).toBe(201); group = (await add.json()).group;
    expect(group.members[0]?.iconSeed).toBe(group.members[0]?.threadId);
    expect(h.calls.filter(c => c.startsWith("submit:"))).toEqual([]);
    const snapshot = await (await h.request(`/swarms/${group.id}`)).json();
    expect(snapshot.group.members[0].name).toBe("Solu");
    expect(snapshot.manager.conversation.threadId).toBe(group.managerThreadId);
    expect(snapshot.workers[0].conversation.threadId).toBe(group.members[0]!.threadId);
    const opened = await h.request(`/swarms/${group.id}/open`, "POST", { threadId: group.members[0]!.threadId });
    expect(opened.status).toBe(200);
    expect(h.calls.filter(c => c.startsWith("submit:"))).toEqual([]);
    expect((await h.request(`/swarms/${group.id}/open`, "POST", { threadId: "unrelated" })).status).toBe(404);
  } finally { h.dispose(); }
});

test("revision, name, lifecycle and workspace checks precede worker provisioning", async () => {
  const h = harness();
  try {
    let group = await h.create();
    const add = await h.request(`/swarms/${group.id}/members`, "POST", { revision: 1, name: "Solu" }); group = (await add.json()).group;
    const creates = h.calls.filter(c => c === "create").length;
    const stale = await h.request(`/swarms/${group.id}/members`, "POST", { revision: 1, name: "Nala" });
    expect(stale.status).toBe(409); expect((await stale.json()).error.code).toBe("swarm_changed");
    expect((await h.request(`/swarms/${group.id}/members`, "POST", { revision: 2, name: "solu" })).status).toBe(409);
    expect((await h.request(`/swarms/${group.id}/close`, "POST", { revision: 2 })).status).toBe(200);
    const closed = await h.request(`/swarms/${group.id}/members`, "POST", { revision: 3, name: "Nala" });
    expect((await closed.json()).error.code).toBe("swarm_closed");
    expect(h.calls.filter(c => c === "create").length).toBe(creates);
    const local = await (await h.request("/swarms", "POST", { name: "Local", project: "/local/project" })).json();
    const shared = await h.request(`/swarms/${local.group.id}/members`, "POST", { revision: 1, name: "Worker" });
    expect(shared.status).toBe(409); expect((await shared.json()).error.code).toBe("isolated_workspace_required");
  } finally { h.dispose(); }
});

test("interrupt reports each worker's outcome and does not close the group or stop its manager", async () => {
  const h = harness();
  try {
    let group = await h.create();
    for (const name of ["Working", "Failing", "Idle", "Unavailable"]) group = (await (await h.request(`/swarms/${group.id}/members`, "POST", { revision: group.revision, name })).json()).group;
    h.active.set(group.managerThreadId, "manager-turn");
    h.active.set(group.members[0]!.threadId, "worker-turn"); h.active.set(group.members[1]!.threadId, "failed-interrupt");
    h.active.delete(group.members[3]!.threadId);
    h.application.conversation.interruptTurn = async id => { if (id === group.members[1]!.threadId) throw new Error("provider failure"); h.active.set(id, null); };
    const results = await (await h.request(`/swarms/${group.id}/interrupt`, "POST", { revision: group.revision })).json();
    expect(results.results.map((r: { outcome: string }) => r.outcome)).toEqual(["interrupted", "failed", "idle", "unavailable"]);
    expect(h.active.get(group.managerThreadId)).toBe("manager-turn");
    expect(h.api.groups.read(group.id).lifecycle).toBe("active");
    const snapshot = await (await h.request(`/swarms/${group.id}`)).json();
    expect(snapshot.workers[3].state).toBe("unknown");
  } finally { h.dispose(); }
});

test("swarm routes share origin, body and quiescing protection with browser conversations", async () => {
  const h = harness();
  try {
    expect((await h.request("/swarms", "POST", { name: "Bad", project: "~" }, { origin: "https://evil.test" })).status).toBe(403);
    expect(h.calls.filter(c => c === "create")).toEqual([]);
    expect((await h.request("/swarms", "POST", { name: "Bad", project: "~", unknown: true })).status).toBe(400);
    expect((await h.request("/swarms", "POST", { name: "Bad", project: "~" }, { "content-type": "text/plain" })).status).toBe(415);
    expect((await h.request("/swarms", "GET", undefined, { origin: "https://ui.example.test" })).headers.get("access-control-allow-origin")).toBe("https://ui.example.test");
    h.abort.abort(); expect((await h.request("/swarms")).status).toBe(503);
  } finally { h.dispose(); }
});

test("durable group membership survives adapter recreation without restoring bindings or starting turns", async () => {
  const directory = mkdtempSync(join(tmpdir(), "shepherd-swarm-store-"));
  const h = harness(new FileSwarmStore(directory));
  try {
    const group = await h.create();
    await h.request(`/swarms/${group.id}/members`, "POST", { revision: 1, name: "Solu" });
    h.api.dispose();
    const next = harness(new FileSwarmStore(directory));
    try {
      expect(next.api.groups.list()[0]!.members[0]!.name).toBe("Solu");
      expect(next.bindings.size).toBe(0);
      const snapshot = await (await next.request(`/swarms/${group.id}`)).json();
      expect(snapshot.manager.conversation).toBeNull(); expect(snapshot.manager.state).toBe("unknown");
      expect(next.calls.filter(c => c.startsWith("submit:"))).toEqual([]);
    } finally { next.dispose(); }
    const store = new FileSwarmStore(directory), saved = store.read(group.id)!;
    expect(() => store.save({ ...saved, name: "Stale overwrite" }, 1)).toThrow("revision conflict");
    const file = join(directory, `${group.id}.json`), persisted = readFileSync(file, "utf8");
    writeFileSync(file, persisted.replace('"version": 1', '"version": 999'));
    expect(() => new FileSwarmStore(directory).read(group.id)).toThrow("Invalid swarm record");
    expect(() => new FileSwarmStore(directory).read("../other")).toThrow("Invalid swarm identity");
  } finally { h.dispose(); rmSync(directory, { recursive: true, force: true }); }
});

test("service rejects duplicate active ownership and concurrent changes", async () => {
  const h = harness();
  try {
    const first = await h.create();
    const service = new SwarmService(h.store, h.api.browser.application.conversation);
    await expect(service.create({ name: "Duplicate", project: "owner/repo", managerThreadId: first.managerThreadId, strategy: "" })).rejects.toThrow("already belongs");
    let release!: () => void;
    h.api.browser.application.conversation.readThread = () => new Promise(resolve => { release = () => resolve({ thread: { id: "worker" } }); });
    const pending = service.addMember(first.id, 1, { threadId: "worker", name: "Solu", assignment: "" });
    await expect(service.close(first.id, 1)).rejects.toThrow("in progress");
    release();
    expect((await pending).members[0]!.threadId).toBe("worker");
  } finally { h.dispose(); }
});

test("rename owns revision checks and serializes provider and record updates", async () => {
  const h = harness();
  try {
    const group = await h.create();
    let started!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const renamed: string[] = [];
    h.api.browser.application.conversation.setThreadName = async (_threadId, { name }) => {
      renamed.push(name); started();
      await new Promise<void>(resolve => { release = resolve; });
      return { ok: true };
    };
    const first = h.request(`/swarms/${group.id}/rename`, "POST", { revision: 1, name: "First title" });
    await entered;
    const competing = await h.request(`/swarms/${group.id}/rename`, "POST", { revision: 1, name: "Stale title" });
    expect(competing.status).toBe(409);
    expect((await competing.json()).error.code).toBe("swarm_busy");
    await expect(h.api.groups.close(group.id, 1)).rejects.toThrow("in progress");
    release();
    expect((await first).status).toBe(200);
    const stale = await h.request(`/swarms/${group.id}/rename`, "POST", { revision: 1, name: "Stale title" });
    expect((await stale.json()).error.code).toBe("swarm_changed");
    expect(renamed).toEqual(["First title"]);
    expect(h.api.groups.read(group.id)).toMatchObject({ name: "First title", revision: 2 });
    h.api.browser.application.conversation.setThreadName = async () => { throw new Error("provider unavailable"); };
    await expect(h.api.groups.rename(group.id, "Failed title", 2)).rejects.toThrow("provider unavailable");
    expect(h.api.groups.read(group.id)).toMatchObject({ name: "First title", revision: 2 });
    // A failed provider operation must release the mutation guard.
    await h.api.groups.close(group.id, 2);
  } finally { h.dispose(); }
});

test("renaming a saved manager after restart attaches it without starting a turn", async () => {
  const store = memoryStore(), first = harness(store);
  let group: SwarmGroup;
  try { group = await first.create(); } finally { first.dispose(); }
  const resumed = harness(store);
  try {
    const names: string[] = [];
    resumed.api.browser.application.conversation.setThreadName = async (threadId, { name }) => {
      if (!resumed.active.has(threadId)) throw new Error("thread not loaded");
      names.push(name); return { ok: true };
    };
    const response = await resumed.request(`/swarms/${group.id}/rename`, "POST", { revision: group.revision, name: "Resumed title" });
    expect(response.status).toBe(200);
    expect(names).toEqual(["Resumed title"]);
    expect(resumed.api.groups.read(group.id)).toMatchObject({ name: "Resumed title", revision: 2 });
    expect(resumed.calls.filter(call => call === "resume")).toHaveLength(1);
    expect(resumed.calls.some(call => call.startsWith("submit:"))).toBe(false);
  } finally { resumed.dispose(); }
});

test("web serves chat, teams and events through one listener", async () => {
  const h = harness();
  const assets = async () => new Map([["/index.html", { body: new TextEncoder().encode("web screen"), contentType: "text/html" }]]);
  const web = createWebChatAdapter(h.context, { ...h.config, port: 0 }, h.store, undefined, assets);
  try {
    await web.start();
    expect(await (await fetch(web.url()!)).text()).toBe("web screen");
    expect((await fetch(`${web.url()}/api/health`, { headers: { origin: "https://evil.test" } })).status).toBe(403);
    const created = await (await fetch(`${web.url()}/api/swarms`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Team", project: "owner/repo" }) })).json();
    const handles = (await (await fetch(`${web.url()}/api/conversations`)).json()).conversations;
    expect(handles.map((c: { threadId: string }) => c.threadId)).toContain(created.group.managerThreadId);
    const abort = new AbortController();
    const feed = await fetch(`${web.url()}/api/swarms/events`, { signal: abort.signal });
    expect(feed.headers.get("content-type")).toBe("text/event-stream");
    const reader = feed.body!.getReader(); expect(new TextDecoder().decode((await reader.read()).value)).toContain(": connected");
    await reader.cancel(); abort.abort();
  } finally { await web.stop(); h.dispose(); }
});

test("web configuration validates the shared listener and team storage path", () => {
  const definition = createWebSurface(() => memoryStore());
  expect(() => definition.configure({ SHEPHERD_WEB_PORT: "bad" })).toThrow("SHEPHERD_WEB_PORT");
  expect(() => definition.configure({ SHEPHERD_WEB_ORIGINS: "http://public.test" })).toThrow("SHEPHERD_WEB_ORIGINS");
  expect(() => definition.configure({ SHEPHERD_SWARM_STATE_DIR: "relative" })).toThrow("absolute");
  expect(() => definition.configure({})).not.toThrow();
});

test("observations keep active turns, pending decisions and terminal history distinct", async () => {
  const h = harness();
  try {
    const group = await h.create();
    const response = await h.request(`/swarms/${group.id}/members`, "POST", { revision: 1, name: "Solu", assignment: "First line\nSecond line" });
    expect(response.status).toBe(201);
    const worker = (await response.json()).group.members[0].threadId;
    h.application.conversation.listThreadTurns = async () => ({ data: [{ id: "finished", status: "completed", items: [] }], nextCursor: null, backwardsCursor: null });
    let snapshot = await (await h.request(`/swarms/${group.id}`)).json();
    expect(snapshot.workers[0].state).toBe("completed");
    h.active.set(worker, "next-turn");
    snapshot = await (await h.request(`/swarms/${group.id}`)).json();
    expect(snapshot.workers[0].state).toBe("running");
    h.context.approvals.listApprovals = () => [{ status: "pending" }] as never;
    snapshot = await (await h.request(`/swarms/${group.id}`)).json();
    expect(snapshot.workers[0].state).toBe("needs-attention");
    expect(snapshot.workers[0].activeTurnId).toBe("next-turn");
    expect(snapshot.group.lifecycle).toBe("active");
  } finally { h.dispose(); }
});

test("aggregate feed invalidates membership and lifecycle without one subscription per worker", async () => {
  const h = harness();
  const abort = new AbortController();
  try {
    const group = await h.create();
    const response = await h.api.fetch(new Request("http://127.0.0.1/api/swarms/events", { signal: abort.signal }));
    const reader = response.body!.getReader();
    await reader.read(); // connection greeting
    await reader.read(); // initial group creation replay
    await h.request(`/swarms/${group.id}/members`, "POST", { revision: 1, name: "Solu" });
    const event = new TextDecoder().decode((await reader.read()).value);
    expect(event).toContain("event: swarm"); expect(event).toContain(group.id);
    await reader.cancel();
  } finally { abort.abort(); h.dispose(); }
});

test("a missing web UI build fails before binding a listener", async () => {
  const h = harness();
  let bound = false;
  const adapter = createWebChatAdapter(h.context, h.config, h.store, () => { bound = true; throw new Error("Unexpected listener"); }, async () => new Map());
  try {
    await expect(adapter.start()).rejects.toThrow("Browser UI entry is missing");
    expect(bound).toBe(false);
  } finally { await adapter.stop(); h.dispose(); }
});


test("new conversation needs only a project; manager authority comes from caller identity and active turn", async () => {
  const h = harness(memoryStore(), true);
  try {
    const response = await h.request("/swarms", "POST", { project: "owner/repo" });
    expect(response.status).toBe(201);
    const group = (await response.json()).group;
    expect(group.name).toBe("New conversation");
    expect(h.calls.filter(c => c.startsWith("submit:"))).toEqual([]);
    await expect(h.manage(group.managerThreadId, "swarm_status")).rejects.toThrow("active manager");
    h.active.set(group.managerThreadId, "manager-turn");
    await expect(h.manage(group.managerThreadId, "swarm_status", {}, "stale-turn")).rejects.toThrow("active manager");
    h.active.set("unrelated", "manager-turn");
    await expect(h.manage("unrelated", "swarm_status")).rejects.toThrow("active manager");
    await expect(h.manage(group.managerThreadId, "swarm_status", { groupId: "forged" })).rejects.toThrow("Unexpected");
    expect((await h.manage(group.managerThreadId, "swarm_status") as { group: SwarmGroup }).group.id).toBe(group.id);
  } finally { h.dispose(); }
  expect(h.connected()).toBe(false);
});

test("delegation watches before sending, appears in saved roster, and deduplicates retries", async () => {
  const h = harness(memoryStore(), true);
  try {
    const group = await h.create(); h.active.set(group.managerThreadId, "manager-turn");
    const args = { name: "Solu", assignment: "Review layout.\nRun checks.", requestId: "layout-1" };
    const result = await h.manage(group.managerThreadId, "swarm_delegate", args) as { threadId: string };
    expect(h.calls.findIndex(c => c.startsWith("watch:"))).toBeLessThan(h.calls.indexOf(`submit:${result.threadId}`));
    expect(h.api.groups.read(group.id).members[0]).toMatchObject({ threadId: result.threadId, name: "Solu", dispatches: [{ key: "layout-1", status: "sent", turnId: "turn-1" }] });
    expect(await h.manage(group.managerThreadId, "swarm_delegate", args)).toMatchObject({ duplicate: true, status: "sent" });
    expect(h.calls.filter(c => c.startsWith("submit:"))).toEqual([`submit:${result.threadId}`]);
    await expect(h.manage(result.threadId, "swarm_status", {}, "turn-1")).rejects.toThrow("active manager");
    await expect(h.manage(group.managerThreadId, "swarm_delegate", { ...args, name: "Another" })).rejects.toThrow("requestId already");
    await expect(h.manage(group.managerThreadId, "swarm_send", { threadId: result.threadId, message: "Follow up", requestId: "layout-2" })).rejects.toThrow("Worker is active");
    await h.manage(group.managerThreadId, "swarm_interrupt", { threadId: result.threadId });
    expect(await h.manage(group.managerThreadId, "swarm_send", { threadId: result.threadId, message: "Follow up", requestId: "layout-2" })).toMatchObject({ status: "sent" });
    expect(h.api.groups.read(group.id).lifecycle).toBe("active");
  } finally { h.dispose(); }
});

test("watch failure leaves a recoverable unsent worker; ambiguous delivery remains pending across recreation", async () => {
  const store = memoryStore(), h = harness(store, true);
  const group = await h.create(); h.active.set(group.managerThreadId, "manager-turn");
  const args = { name: "Solu", assignment: "Review", requestId: "review-1" };
  try {
    h.failWatch(true);
    await expect(h.manage(group.managerThreadId, "swarm_delegate", args)).rejects.toThrow("watch unavailable");
    expect(h.api.groups.read(group.id).members).toHaveLength(1);
    expect(h.calls.some(c => c.startsWith("submit:"))).toBe(false);
    h.failWatch(false);
    h.context.ingress.submitTurn = async () => { throw new Error("connection lost after acceptance"); };
    await expect(h.manage(group.managerThreadId, "swarm_delegate", args)).rejects.toThrow("connection lost");
    expect(h.api.groups.read(group.id).members[0]!.dispatches![0]!.status).toBe("pending");
  } finally { h.dispose(); }
  const next = harness(store, true);
  try {
    await next.request(`/swarms/${group.id}/open`, "POST", { threadId: group.managerThreadId });
    next.active.set(group.managerThreadId, "manager-turn");
    expect(await next.manage(group.managerThreadId, "swarm_delegate", args)).toMatchObject({ status: "pending", duplicate: true });
    expect(next.calls.some(c => c.startsWith("submit:"))).toBe(false);
    await next.manage(group.managerThreadId, "swarm_status");
    expect(next.calls.some(c => c.startsWith("watch:"))).toBe(true);
    expect(next.calls.some(c => c === "resume")).toBe(true);
  } finally { next.dispose(); }
});

test("reports, decisions, and interrupts are restricted to the manager's actual workers", async () => {
  const h = harness(memoryStore(), true);
  try {
    const group = await h.create(); h.active.set(group.managerThreadId, "manager-turn");
    const result = await h.manage(group.managerThreadId, "swarm_delegate", { name: "Solu", assignment: "Review", requestId: "review-1" }) as { threadId: string };
    const report = await h.manage(group.managerThreadId, "swarm_report", { threadId: result.threadId }) as { dispatches: unknown[]; history: string };
    expect(report.dispatches).toHaveLength(1); expect(report.history).toContain("data");
    for (const tool of ["swarm_report", "swarm_interrupt", "swarm_decide", "swarm_send"]) await expect(h.manage(group.managerThreadId, tool, { threadId: group.managerThreadId })).rejects.toThrow("not in this manager");
    await expect(h.manage(group.managerThreadId, "swarm_decide", { threadId: result.threadId, approvalId: "invented", decision: "approve" })).rejects.toThrow("current pending");
    const approval = h.approvals.create({ approvalId: "permission-1", kind: "permission", activity: { kind: "command", command: "bun test", cwd: null, result: null }, reason: null, choices: [{ value: "allow-once", label: "Allow", intent: "allow" }] }, { threadId: result.threadId, sessionId: "session" });
    await expect(h.manage(group.managerThreadId, "swarm_decide", { threadId: result.threadId, approvalId: approval.approvalId, decision: "invented" })).rejects.toThrow("offered");
    expect(await h.manage(group.managerThreadId, "swarm_decide", { threadId: result.threadId, approvalId: approval.approvalId, decision: "allow-once" })).toEqual({ applied: true });
    const current = h.api.groups.read(group.id); await h.api.groups.close(group.id, current.revision);
    expect(await h.manage(group.managerThreadId, "swarm_status")).toMatchObject({ group: null, workers: [] });
  } finally { h.dispose(); }
});


test("interrupting the manager during provisioning prevents assignment dispatch", async () => {
  const h = harness(memoryStore(), true);
  try {
    const group = await h.create(); h.active.set(group.managerThreadId, "manager-turn");
    const create = h.api.browser.create.bind(h.api.browser);
    h.api.browser.create = async (...args) => { const worker = await create(...args); h.active.set(group.managerThreadId, null); return worker; };
    await expect(h.manage(group.managerThreadId, "swarm_delegate", { name: "Solu", assignment: "Review", requestId: "review-1" })).rejects.toThrow("manager turn ended");
    expect(h.api.groups.read(group.id).members).toEqual([]);
    expect(h.calls.some(c => c.startsWith("submit:"))).toBe(false);
    expect(h.api.browser.listConversations()).toHaveLength(1);
  } finally { h.dispose(); }
});

test("manager cancellation after recording a pending receipt prevents submission", async () => {
  const h = harness(memoryStore(), true);
  try {
    const group = await h.create(); h.active.set(group.managerThreadId, "manager-turn");
    const dispatch = h.api.groups.dispatch.bind(h.api.groups);
    h.api.groups.dispatch = async (...args) => {
      const result = await dispatch(...args);
      if (args[2].status === "pending") h.active.set(group.managerThreadId, null);
      return result;
    };
    await expect(h.manage(group.managerThreadId, "swarm_delegate", { name: "Solu", assignment: "Review", requestId: "cancelled-1" })).rejects.toThrow("manager turn ended");
    expect(h.calls.some(c => c.startsWith("submit:"))).toBe(false);
    const saved = h.api.groups.read(group.id);
    expect(saved.members[0]!.dispatches).toEqual([{ key: "cancelled-1", status: "pending", turnId: null }]);
    h.active.set(group.managerThreadId, "manager-turn");
    expect(await h.manage(group.managerThreadId, "swarm_delegate", { name: "Solu", assignment: "Review", requestId: "cancelled-1" })).toMatchObject({ duplicate: true, status: "pending" });
    expect(h.calls.some(c => c.startsWith("submit:"))).toBe(false);
  } finally { h.dispose(); }
});

test("ordinary chats have zero workers without allocating groups; first delegation creates one team", async () => {
  const h = harness(memoryStore(), true);
  try {
    const parent = await (await h.request("/conversations", "POST", { project: "owner/repo" })).json();
    h.active.set(parent.threadId, "manager-turn");
    for (let i = 0; i < 3; i++) expect(await h.manage(parent.threadId, "swarm_status")).toMatchObject({ group: null, workers: [] });
    expect(h.store.list()).toHaveLength(0);
    await expect(h.manage(parent.threadId, "swarm_delegate", { name: "Bad", assignment: "", requestId: "bad" })).rejects.toThrow("Invalid assignment");
    expect(h.store.list()).toHaveLength(0);
    const assignment = { name: "Research", assignment: "Inspect the implementation", requestId: "first" };
    const worker = await h.manage(parent.threadId, "swarm_delegate", assignment) as { threadId: string };
    expect(h.store.list()).toHaveLength(1);
    expect(h.store.list()[0]!.managerThreadId).toBe(parent.threadId);
    expect(await h.manage(parent.threadId, "swarm_delegate", assignment)).toMatchObject({ duplicate: true, threadId: worker.threadId });
    const handles = (await (await h.request("/conversations")).json()).conversations;
    expect(handles.map((c: { threadId: string }) => c.threadId)).toEqual([parent.threadId]);
    const resumed = await (await h.request("/conversations", "POST", { threadId: parent.threadId })).json();
    expect(resumed.id).toBe(parent.id);
    const group = h.store.list()[0]!;
    const inspected = await (await h.request(`/swarms/${group.id}/open`, "POST", { threadId: worker.threadId })).json();
    expect(inspected.threadId).toBe(worker.threadId);
    expect((await h.request(`/conversations/${inspected.id}/messages`, "POST", { text: "bypass" })).status).toBe(403);
    expect((await h.request("/conversations", "POST", { threadId: worker.threadId })).status).toBe(403);
    h.active.set(worker.threadId, "manager-turn");
    await expect(h.manage(worker.threadId, "swarm_status")).rejects.toThrow("active manager");
    await h.api.groups.close(group.id, group.revision);
    await expect(h.manage(worker.threadId, "swarm_delegate", assignment)).rejects.toThrow("active manager");
    expect((await h.request("/swarms", "POST", { managerThreadId: worker.threadId })).status).toBe(403);
  } finally { h.dispose(); }
});

test("ordinary local chats remain usable without allocating an unusable team", async () => {
  const h = harness(memoryStore(), true);
  try {
    const parent = await (await h.request("/conversations", "POST", { project: "/local/project" })).json();
    h.active.set(parent.threadId, "manager-turn");
    expect(await h.manage(parent.threadId, "swarm_status")).toMatchObject({ group: null });
    await expect(h.manage(parent.threadId, "swarm_delegate", { name: "Worker", assignment: "Inspect", requestId: "local" })).rejects.toThrow("owner/repo");
    expect(h.store.list()).toHaveLength(0);
  } finally { h.dispose(); }
});

test("saved workers stay hidden in paginated active and archived listings after restart", async () => {
  const store = memoryStore();
  const first = harness(store, true);
  const group = await first.create();
  first.active.set(group.managerThreadId, "manager-turn");
  const worker = await first.manage(group.managerThreadId, "swarm_delegate", { name: "Review", assignment: "Inspect", requestId: "saved" }) as { threadId: string };
  first.dispose();
  const resumed = harness(store, true);
  try {
    resumed.application.conversation.listStoredThreads = async () => ({ threads: [{ threadId: group.managerThreadId }, { threadId: worker.threadId }], nextCursor: "next-page" }) as never;
    for (const suffix of ["", "?archived=true"]) {
      const page = await (await resumed.request(`/threads${suffix}`)).json();
      expect(page.threads.map((t: { threadId: string }) => t.threadId)).toEqual([group.managerThreadId]);
      expect(page.nextCursor).toBe("next-page");
    }
    resumed.active.set(group.managerThreadId, "manager-turn"); resumed.active.set(worker.threadId, null);
    await resumed.request("/conversations", "POST", { threadId: group.managerThreadId });
    resumed.active.set(group.managerThreadId, "manager-turn");
    expect(await resumed.manage(group.managerThreadId, "swarm_status")).toMatchObject({ group: { id: group.id } });
    expect(resumed.calls.some(c => c === `watch:${worker.threadId}`)).toBe(true);
    expect(resumed.calls.some(c => c.startsWith("submit:"))).toBe(false);
  } finally { resumed.dispose(); }
});
