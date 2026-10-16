import { expect, test } from "bun:test";
import type { BridgeEvent } from "../shared/protocol/events.js";
import { CodexProvider } from "../server/providers/codex/provider.js";
import { noProviderTools } from "../server/ports/provider_tools.js";
import { fakeAppServer } from "./helpers/fake_app_server.js";

function harness() {
  let threads = 0;
  const fake = fakeAppServer(({ method }) => {
    if (method === "thread/start") return { thread: { id: `thread-${++threads}` }, cwd: "/repo", model: "gpt" };
    if (method === "thread/list") return { data: [], nextCursor: null };
    if (method === "thread/unsubscribe") return { status: "unsubscribed" };
    return {};
  });
  const provider = new CodexProvider(undefined, fake.server);
  const open = async () => {
    const session = provider.openSession(noProviderTools);
    const events: BridgeEvent[] = []; session.eventBus.subscribe(event => events.push(event), { replay: false });
    const { threadId } = await session.startThread({});
    return { session, events, threadId };
  };
  return { fake, provider, open };
}
const completed = (threadId: string, id: string) => ({ threadId, turnId: "turn", item: { type: "agentMessage", id, text: id, phase: "final" } });

test("Codex threads, history and discovery share one app-server process, each thread receiving its own traffic", async () => {
  const h = harness();
  const a = await h.open(), b = await h.open();
  await h.provider.listStoredThreads({});
  expect(h.fake.processes).toHaveLength(1);
  expect([a.threadId, b.threadId]).toEqual(["thread-1", "thread-2"]);
  await h.fake.notify("item/completed", completed("thread-1", "for-a"));
  await h.fake.notify("item/completed", completed("thread-2", "for-b"));
  // A thread no session runs, such as one only read, has no one to notify.
  await h.fake.notify("item/completed", completed("thread-9", "for-nobody"));
  const items = (events: BridgeEvent[]) => events.flatMap(event => event.type === "item.completed" ? [event.payload.item.id] : []);
  expect(items(a.events)).toEqual(["for-a"]);
  expect(items(b.events)).toEqual(["for-b"]);
  // Requests reach the session running their thread; a request for no running thread is refused.
  await h.fake.request(50, "item/commandExecution/requestApproval", { threadId: "thread-2", turnId: "turn", itemId: "cmd", command: "ls" });
  expect(b.events.some(event => event.type === "approval.requested")).toBe(true);
  expect(a.events.some(event => event.type === "approval.requested")).toBe(false);
  await h.fake.request(51, "item/commandExecution/requestApproval", { threadId: "thread-9", turnId: "turn", itemId: "cmd", command: "ls" });
  expect(h.fake.received()).toContainEqual({ id: 51, error: { code: -32602, message: expect.stringContaining("No conversation") } });
  h.provider.stop();
});

test("stopping a session releases its thread and leaves the process to the others", async () => {
  const h = harness();
  const a = await h.open(), b = await h.open();
  a.session.stop();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(h.fake.received()).toContainEqual({ id: expect.any(Number), method: "thread/unsubscribe", params: { threadId: "thread-1" } });
  await h.fake.notify("item/completed", completed("thread-1", "after-stop"));
  await h.fake.notify("item/completed", completed("thread-2", "still-running"));
  expect(a.events.some(event => event.type === "item.completed")).toBe(false);
  expect(b.events.some(event => event.type === "item.completed")).toBe(true);
  expect(h.fake.processes).toHaveLength(1);
  h.provider.stop();
});

test("when the process exits every session hears it, and the next use starts a new process", async () => {
  const h = harness();
  const a = await h.open(), b = await h.open();
  h.fake.exit();
  for (const { events } of [a, b]) expect(events.filter(event => event.type === "session.error").map(event => event.payload)).toEqual([{ message: expect.stringContaining("exited") }]);
  await expect(h.provider.listStoredThreads({})).resolves.toBeDefined();
  expect(h.fake.processes).toHaveLength(2);
  const c = await h.open();
  expect(c.threadId).toBe("thread-3");
  h.provider.stop();
});
