import { expect, test } from "bun:test";
import { webHarness } from "./helpers/web_harness";

test("history browser forwards summary/item pagination through shared conversation ports", async () => {
  const h = webHarness(); let received: unknown;
  h.application.conversation.listThreadTurns = async (_id, request) => { received = request; return { data: [], nextCursor: "next", backwardsCursor: null }; };
  Object.assign(h.application.conversation, { async listThreadItems(id: string, request: unknown) { received = { id, request }; return { data: [{ turnId: "turn", item: { id: "cmd", type: "commandExecution", command: "echo hello", status: "completed" } }], nextCursor: "items-next", backwardsCursor: null }; } });
  try {
    const c = await h.create(); const path = `/conversations/${c.id}/history`;
    const turns = await (await h.request(`${path}?limit=10&cursor=page2`)).json();
    expect(turns).toEqual({ view: "turns", data: [], nextCursor: "next", revision: 0 });
    expect(received).toEqual({ limit: 10, cursor: "page2", sortDirection: "desc", itemsView: "summary" });
    const items = await (await h.request(`${path}?turnId=turn&cursor=next&revision=0&limit=10`)).json();
    expect(items.view).toBe("items"); expect(items.data[0].item.webActivity.label).toBe("Running command");
    expect(received).toEqual({ id: c.threadId, request: { turnId: "turn", cursor: "next", limit: 10, sortDirection: "asc" } });
    for (const query of ["turnId=", "revision=bad", "revision=-1", "limit=0", "extra=true"]) expect((await h.request(`${path}?${query}`)).status).toBe(400);
    expect((await h.request(`${path}?revision=1`)).status).toBe(409);
    expect((await h.request(path, "GET", undefined, { origin: "https://evil.test" })).status).toBe(403);
  } finally { h.api.dispose(); }
});

test("history reads crossing rollback and stale navigation revisions are rejected", async () => {
  const h = webHarness(); let release!: () => void;
  Object.assign(h.application, { getSurfaceThreadId: (id: string) => h.bindings.get(id) });
  Object.assign(h.application.conversation, { rollbackThread: async () => ({ thread: {} }), listThreadItems: async () => { await new Promise<void>((resolve) => { release = resolve; }); return { data: [], nextCursor: null }; } });
  try {
    const c = await h.create(); const path = `/conversations/${c.id}`;
    const pending = h.request(`${path}/history?turnId=turn`);
    while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
    expect((await h.request(`${path}/rollback`, "POST", { numTurns: 1 })).status).toBe(200);
    release(); expect((await pending).status).toBe(409);
    expect((await h.request(`${path}/history?revision=0`)).status).toBe(409);
    expect((await (await h.request(`${path}/history`)).json()).revision).toBe(1);
    await h.request(path, "DELETE"); expect((await h.request(`${path}/history`)).status).toBe(404);
  } finally { release?.(); h.api.dispose(); }
});
