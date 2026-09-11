import { expect, spyOn, test } from "bun:test";
import { initialHistoryRequest, loadHistoryPage } from "../server/adapters/discord/history_pagination.js";
import { handleInteraction } from "../server/adapters/discord/interactions.js";
import { handleMessage } from "../server/adapters/discord/commands.js";
import { CodexSession } from "../server/core/codex_session.js";
import { SessionManager } from "../server/core/session_manager.js";

function button(page: unknown, label: string): any {
  return JSON.parse(JSON.stringify(page)).components[0].components
    .flatMap((component: any) => component.components ?? [])
    .find((component: any) => component.label === label);
}

function turn(id: string) {
  return {
    id, status: "completed" as const, itemsView: "summary" as const,
    items: [{ id: "message", type: "userMessage", content: [{ type: "text", text: `Question ${id}` }] }],
    startedAt: 100, completedAt: 101, durationMs: 1000, error: null,
  };
}

test("history navigation passes opaque cursors and stays bound to the original thread", async () => {
  const requests: any[] = [];
  const longCursor = "opaque|cursor/".repeat(100);
  const conversation = {
    async listThreadTurns(threadId: string, request: any) {
      requests.push({ threadId, ...request });
      return {
        data: [turn(request.cursor ? "older" : "newest")],
        nextCursor: request.cursor ? null : longCursor, backwardsCursor: "reverse",
      };
    },
    async listThreadItems(threadId: string, request: any) {
      requests.push({ threadId, ...request });
      return { data: [{ turnId: "newest", item: { id: "item", type: "agentMessage", text: "Answer" } }], nextCursor: null, backwardsCursor: "reverse-items" };
    },
  };
  let page: unknown = await loadHistoryPage(conversation, initialHistoryRequest("original", "user-1"));
  expect(button(page, "Previous").disabled).toBe(true);
  for (const label of ["Next", "Previous", "Items 1", "Back to turns"]) {
    const customId = button(page, label).custom_id;
    expect(customId.length).toBeLessThanOrEqual(100);
    await handleInteraction({
      customId, user: { id: "user-1" }, channelId: "channel",
      async deferUpdate() {},
      async editReply(value: unknown) { page = value; },
    } as never, conversation as never, { getSurfaceThreadId: () => "different" });
    if (label === "Next") {
      expect(requests.at(-1)).toEqual({
        threadId: "original", cursor: longCursor, limit: 5, sortDirection: "desc", itemsView: "summary",
      });
      expect(button(page, "Next").disabled).toBe(true);
    }
    if (label === "Previous") expect(requests.at(-1).cursor).toBeUndefined();
    if (label === "Items 1") {
      expect(requests.at(-1)).toEqual({ threadId: "original", turnId: "newest", cursor: undefined, limit: 5, sortDirection: "asc" });
      expect(JSON.stringify(page)).toContain("Answer");
    }
  }
});

test("item pages support next, previous and first without hydrating turns", async () => {
  const calls: any[] = [];
  const conversation = {
    async listThreadTurns() { throw new Error("unexpected full turn read"); },
    async listThreadItems(threadId: string, request: any) {
      calls.push(request);
      return {
        data: [{ turnId: "turn", item: { id: "item", type: "agentMessage", text: request.cursor ?? "first" } }],
        nextCursor: request.cursor === "last" ? null : request.cursor ? "last" : "second",
        backwardsCursor: null,
      };
    },
  };
  let page: unknown = await loadHistoryPage(conversation, initialHistoryRequest("thread", "user", "turn"));
  for (const label of ["Next", "Next", "Previous", "First"]) {
    await handleInteraction({
      customId: button(page, label).custom_id, user: { id: "user" },
      async deferUpdate() {},
      async editReply(value: unknown) { page = value; },
    } as never, conversation as never);
  }
  expect(calls.map((call) => call.cursor)).toEqual([undefined, "second", "last", "second", undefined]);
  expect(button(page, "First").disabled).toBe(true);
});

test("history handles empty results and long excerpts without losing entries or controls", async () => {
  const conversation = {
    async listThreadTurns() { return { data: [], nextCursor: null, backwardsCursor: null }; },
    async listThreadItems() {
      return {
        data: Array.from({ length: 5 }, (_, i) => ({
          turnId: "turn", item: { id: String(i), type: "agentMessage", text: "*".repeat(9000) },
        })),
        nextCursor: null, backwardsCursor: null,
      };
    },
  };
  const empty = await loadHistoryPage(conversation, initialHistoryRequest("thread", "user"));
  expect(JSON.stringify(empty)).toContain("No turns found.");
  expect(button(empty, "Next").disabled).toBe(true);
  const long = await loadHistoryPage(conversation, initialHistoryRequest("thread", "user", "turn"));
  expect(JSON.stringify(long)).toContain("5. Assistant message");
  expect(JSON.stringify(long)).not.toContain("Turn items (1/");
  expect(button(long, "Back to turns")).toBeDefined();
});

test("history rejects other users and expired controls without fetching", async () => {
  const conversation = {
    async listThreadTurns() { return { data: [turn("turn")], nextCursor: "next", backwardsCursor: null }; },
  };
  const page = await loadHistoryPage(conversation as never, initialHistoryRequest("thread", "owner"));
  const replies: unknown[] = [];
  const interaction = {
    customId: button(page, "Next").custom_id, user: { id: "someone-else" },
    async reply(value: unknown) { replies.push(value); },
  };
  await handleInteraction(interaction as never, {} as never);
  expect(JSON.stringify(replies.at(-1))).toContain("Only the person");
  const now = Date.now();
  const clock = spyOn(Date, "now").mockReturnValue(now + 61 * 60 * 1000);
  try {
    await handleInteraction(interaction as never, {} as never);
    expect(JSON.stringify(replies.at(-1))).toContain("expired");
  } finally { clock.mockRestore(); }
});

test("history fetch failures acknowledge and preserve the existing card", async () => {
  const page = await loadHistoryPage({
    async listThreadTurns() { return { data: [turn("turn")], nextCursor: "next", backwardsCursor: null }; },
  } as never, initialHistoryRequest("thread", "owner"));
  const lifecycle: string[] = [];
  await handleInteraction({
    customId: button(page, "Next").custom_id, user: { id: "owner" },
    async deferUpdate() { lifecycle.push("defer"); },
    async followUp(value: unknown) { lifecycle.push("error"); expect(JSON.stringify(value)).toContain("failed to read"); },
  } as never, {
    async listThreadTurns() { lifecycle.push("fetch"); throw new Error("failed to read"); },
  } as never);
  expect(lifecycle).toEqual(["defer", "fetch", "error"]);
});

test("history APIs preserve filters and both cursors without resuming a stored thread", async () => {
  const session = new CodexSession("on-request");
  session.initialize = async () => {};
  const requests: any[] = [];
  const response = { data: [], nextCursor: "next", backwardsCursor: "back" };
  (session as any).sendRequest = async (method: string, params: unknown) => {
    requests.push({ method, params }); return response;
  };
  const manager = new SessionManager();
  (manager as any).getControlSession = async () => session;
  expect(await manager.listThreadTurns("stored", { cursor: "cursor", limit: 5, sortDirection: "desc", itemsView: "summary" })).toEqual(response);
  expect(await manager.listThreadItems("stored", { turnId: "turn", cursor: "item-cursor", limit: 5, sortDirection: "asc" })).toEqual(response);
  expect(requests).toEqual([
    { method: "thread/turns/list", params: { threadId: "stored", cursor: "cursor", limit: 5, sortDirection: "desc", itemsView: "summary" } },
    { method: "thread/items/list", params: { threadId: "stored", turnId: "turn", cursor: "item-cursor", limit: 5, sortDirection: "asc" } },
  ]);
});

test("history commands select active or explicit threads and validate arguments", async () => {
  const calls: any[] = [];
  const replies: unknown[] = [];
  const conversation = {
    async listThreadTurns(threadId: string) { calls.push(["turns", threadId]); return { data: [], nextCursor: null }; },
    async listThreadItems(threadId: string, request: any) { calls.push(["items", threadId, request.turnId]); return { data: [], nextCursor: null }; },
  };
  const message = {
    content: "", channelId: "channel", author: { id: "user" },
    async reply(value: unknown) { replies.push(value); return { id: "reply" }; },
  };
  let active: string | null = "active";
  for (const command of ["!history", "!history stored", "!history items turn stored", "!history items"]) {
    message.content = command;
    await handleMessage(message as never, { conversation, getSurfaceThreadId: () => active } as never);
  }
  expect(calls).toEqual([["turns", "active"], ["turns", "stored"], ["items", "stored", "turn"]]);
  expect(JSON.stringify(replies.at(-1))).toContain("Usage:");
  active = null;
  message.content = "!history";
  await handleMessage(message as never, { conversation, getSurfaceThreadId: () => active } as never);
  expect(JSON.stringify(replies.at(-1))).toContain("Thread required");
});

test("Read buttons show the full long message over pages and return to the item list", async () => {
  let fetches = 0;
  const conversation = {
    async listThreadItems() {
      fetches++;
      return {
        data: [{ turnId: "turn", item: { id: "item", type: "agentMessage", text: "start " + "word ".repeat(2000) + "THE END" } }],
        nextCursor: null, backwardsCursor: null,
      };
    },
  };
  let page: unknown = await loadHistoryPage(conversation as never, initialHistoryRequest("thread", "owner", "turn"));
  const click = async (label: string) => {
    await handleInteraction({
      customId: button(page, label).custom_id, user: { id: "owner" },
      async deferUpdate() {},
      async editReply(value: unknown) { page = value; },
    } as never, conversation as never);
  };
  await click("Read 1");
  expect(JSON.stringify(page)).toContain("start");
  while (!button(page, "Next").disabled) await click("Next");
  expect(JSON.stringify(page)).toContain("THE END");
  expect(fetches).toBe(1);
  await click("First");
  expect(JSON.stringify(page)).toContain("start");
  await click("Back to items");
  expect(button(page, "Read 1")).toBeDefined();
  expect(fetches).toBe(2);
});
