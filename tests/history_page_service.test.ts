import { expect, test } from "bun:test";
import {
  initialHistoryPage, loadHistoryPage, openHistoryTurn, returnToHistoryTurns,
  type HistoryPageSource,
} from "../server/core/history_page_service.js";
import type { ListThreadItemsRequest, ListThreadTurnsRequest } from "../shared/protocol/requests.js";

function source() {
  const calls: Array<{ threadId: string; request: ListThreadTurnsRequest | ListThreadItemsRequest }> = [];
  const cursor = "opaque|".repeat(100);
  const api: HistoryPageSource = {
    async listThreadTurns(threadId, request) {
      calls.push({ threadId, request });
      return {
        data: [{
          id: "turn", status: "completed", itemsView: "summary", startedAt: 1, completedAt: 2, durationMs: 1000, error: null,
          items: [{ id: "user", type: "userMessage", content: [{ type: "text", text: "original".repeat(500) }] }],
        }],
        nextCursor: request.cursor ? null : cursor, backwardsCursor: "inclusive-anchor",
      };
    },
    async listThreadItems(threadId, request) {
      calls.push({ threadId, request });
      return {
        data: [{ turnId: "turn", item: { id: "item", type: "agentMessage", text: "complete".repeat(500), extra: { preserved: true } } }],
        nextCursor: request.cursor ? null : cursor, backwardsCursor: "item-anchor",
      };
    },
  };
  return { api, calls, cursor };
}

test("history pages expose raw records and forward-cursor navigation independently of a surface", async () => {
  const { api, calls, cursor } = source();
  const initial = initialHistoryPage("stored-thread", 2);
  const before = JSON.stringify(initial);
  const first = await loadHistoryPage(api, initial);
  expect(first).toMatchObject({ view: "turns", offset: 0, previous: null });
  expect(first.result.backwardsCursor).toBe("inclusive-anchor");
  expect(JSON.stringify(first.result)).toContain("original".repeat(500));
  expect(first.next).toMatchObject({ threadId: "stored-thread", page: 2, pageSize: 2, cursors: [null, cursor] });
  expect(JSON.stringify(initial)).toBe(before);
  const second = await loadHistoryPage(api, first.next!);
  expect(second).toMatchObject({ offset: 2, next: null });
  await loadHistoryPage(api, second.previous!);
  expect(calls.map(({ request }) => request.cursor)).toEqual([undefined, cursor, undefined]);
  expect(calls.every(({ threadId, request }) => threadId === "stored-thread" && request.limit === 2 && request.sortDirection === "desc")).toBe(true);
});

test("opening a turn and returning preserves the exact parent page and item metadata", async () => {
  const { api, calls } = source();
  const first = await loadHistoryPage(api, initialHistoryPage("thread", 3));
  const parent = first.next!;
  const turn = openHistoryTurn(parent, "turn");
  const items = await loadHistoryPage(api, turn);
  expect(items.view).toBe("items");
  expect(calls.at(-1)).toEqual({ threadId: "thread", request: { cursor: undefined, limit: 3, turnId: "turn", sortDirection: "asc" } });
  if (items.view !== "items") throw new Error("Expected items");
  expect(items.result.data[0]!.item).toMatchObject({ text: "complete".repeat(500), extra: { preserved: true } });
  const next = await loadHistoryPage(api, items.next!);
  expect(returnToHistoryTurns(next.request)).toEqual(parent);
  expect(returnToHistoryTurns(initialHistoryPage("thread", 3, "turn"))).toEqual(initialHistoryPage("thread", 3));
});

test("empty history and request failures retain predictable navigation", async () => {
  const { api } = source();
  api.listThreadTurns = async () => ({ data: [], nextCursor: null, backwardsCursor: null });
  expect(await loadHistoryPage(api, initialHistoryPage("thread", 5))).toMatchObject({
    result: { data: [] }, previous: null, next: null,
  });
  api.listThreadTurns = async () => { throw new Error("Unavailable"); };
  const request = initialHistoryPage("thread", 5);
  await expect(loadHistoryPage(api, request)).rejects.toThrow("Unavailable");
  expect(request.cursors).toEqual([null]);
});

test("invalid history state is rejected before making an API call", async () => {
  const { api, calls } = source();
  const initial = initialHistoryPage("thread", 5);
  for (const request of [
    { ...initial, page: 0 },
    { ...initial, pageSize: NaN },
    { ...initial, page: 2 },
    { ...initial, page: 2, cursors: [null, null] },
    { ...initial, threadId: "" },
  ]) {
    await expect(loadHistoryPage(api, request)).rejects.toThrow();
  }
  expect(calls).toEqual([]);
});
