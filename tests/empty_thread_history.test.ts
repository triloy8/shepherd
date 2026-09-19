import { expect, test } from "bun:test";
import { CodexSession } from "../server/core/codex_session.js";
import { webHarness } from "./helpers/web_harness.js";

function transport() {
  const session = new CodexSession("on-request");
  session.initialize = async () => {};
  let failure: string | null = null;
  let data: unknown[] = [];
  const raw = session as unknown as { writeLine: (request: { id: number; method: string }) => void; onServerLine: (line: string) => void };
  raw.writeLine = (request) => {
    queueMicrotask(() => raw.onServerLine(JSON.stringify({ id: request.id, ...(failure
      ? { error: { code: -32600, message: failure } }
      : { result: { data, nextCursor: null, backwardsCursor: null } }) })));
  };
  return { session, fail: (message: string | null) => { failure = message; }, data: (value: unknown[]) => { data = value; } };
}
const notMaterialized = (id: string) => `thread ${id} is not materialized yet; thread/turns/list is unavailable before first user message`;

test("new thread history is an empty page, then reads subsequent stored turns", async () => {
  const t = transport();
  try {
    t.fail(notMaterialized("thread"));
    expect(await t.session.listThreadTurns("thread", { itemsView: "full" })).toEqual({ data: [], nextCursor: null, backwardsCursor: null });
    const data = [{ id: "turn", items: [], status: "completed" }];
    t.fail(null); t.data(data);
    expect((await t.session.listThreadTurns("thread", { itemsView: "full" })).data).toEqual(data);
  } finally { t.session.stop(); }
});

test("history normalization preserves unrelated errors and invalid pagination", async () => {
  const t = transport();
  try {
    for (const message of ["thread not found", "transport failed", "invalid cursor", notMaterialized("other")]) {
      t.fail(message);
      await expect(t.session.listThreadTurns("thread", {})).rejects.toThrow(message);
    }
    t.fail(notMaterialized("thread"));
    await expect(t.session.listThreadTurns("thread", { cursor: "stale" })).rejects.toThrow("not materialized");
  } finally { t.session.stop(); }
});

test("web initial history uses the real session error mapping instead of returning 502", async () => {
  const h = webHarness();
  const t = transport();
  try {
    const conversation = await h.create();
    h.application.conversation.listThreadTurns = (threadId, request) => t.session.listThreadTurns(threadId, request as never);
    t.fail(notMaterialized(conversation.threadId));
    const response = await h.request(`/conversations/${conversation.id}/turns?limit=30`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [], nextCursor: null, backwardsCursor: null });
  } finally { h.api.dispose(); t.session.stop(); }
});
