import { describe, expect, test } from "bun:test";

import type { DynamicToolCallParams, DynamicToolCallResponse, JsonValue } from "../shared/protocol/dynamic_tools.js";
import type { BridgeEvent } from "../shared/protocol/events.js";
import { SignalDispatcher, type SignalDispatchResult } from "../server/core/signals/signal_dispatcher.js";
import type { RegisteredSignal } from "../server/core/signals/signal_registry.js";
import {
  THREAD_WATCH_SIGNAL_KIND,
  ThreadWatchService,
  type ThreadWatchPayload,
} from "../server/core/signals/thread_watch_service.js";

type Listener = (event: BridgeEvent) => void;

function harness(options: { capacity?: number; groupCapacity?: number; dispatch?: SignalDispatchResult["type"] } = {}) {
  let clock = 1_000_000;
  const threads = new Map<string, { activeTurnId: string | null; sessionId: string }>([
    ["parent", { activeTurnId: "turn-p", sessionId: "s-parent" }],
    ["child-1", { activeTurnId: null, sessionId: "s-1" }],
    ["child-2", { activeTurnId: "turn-c2", sessionId: "s-2" }],
    ["child-3", { activeTurnId: null, sessionId: "s-3" }],
  ]);
  const listeners = new Map<string, Set<Listener>>();
  const accepted: RegisteredSignal[] = [];
  const errors: unknown[] = [];
  let surface: { adapter: string; surfaceId: string } | null = { adapter: "web", surfaceId: "handle-1" };
  const service = new ThreadWatchService({
    conversation: {
      getThreadState(threadId) {
        const state = threads.get(threadId);
        if (!state) throw new Error(`Thread not loaded: ${threadId}`);
        return { ...state };
      },
      async getThreadCwd(threadId) { return `/work/${threadId}`; },
      getThreadSurface: () => surface,
      subscribeToThreadEvents(threadId, listener) {
        const key = `${threadId}@${threads.get(threadId)!.sessionId}`;
        const set = listeners.get(key) ?? new Set<Listener>();
        set.add(listener);
        listeners.set(key, set);
        return () => { set.delete(listener); };
      },
    },
    dispatcher: {
      async accept(signal) {
        accepted.push(signal);
        return options.dispatch === undefined
          ? { type: "accepted", threadId: signal.target.threadId }
          : { type: options.dispatch } as SignalDispatchResult;
      },
    },
    capacity: options.capacity,
    groupCapacity: options.groupCapacity,
    now: () => clock,
    onError: (error) => errors.push(error),
  });
  const tools = new Map(service.registrations().map((tool) => [tool.name, tool]));
  const call = (name: string, args: JsonValue, overrides: Partial<DynamicToolCallParams> = {}): Promise<DynamicToolCallResponse> =>
    tools.get(name)!.execute({ threadId: "parent", turnId: "turn-p", callId: "c", namespace: "shepherd", tool: name, arguments: args, ...overrides });
  let sequence = 0;
  const emit = (threadId: string, type: string, payload: Record<string, unknown>) => {
    const key = `${threadId}@${threads.get(threadId)?.sessionId}`;
    const event = { id: `e${++sequence}`, type, threadId, sessionId: "x", ts: "now", payload } as unknown as BridgeEvent;
    for (const listener of [...listeners.get(key) ?? []]) listener(event);
  };
  const subscribers = (threadId: string) => listeners.get(`${threadId}@${threads.get(threadId)?.sessionId}`)?.size ?? 0;
  return {
    service, call, emit, accepted, errors, threads, subscribers,
    advance: (ms: number) => { clock += ms; },
    setSurface: (value: typeof surface) => { surface = value; },
    flush: () => new Promise((resolve) => setTimeout(resolve, 0)),
  };
}

function body(response: DynamicToolCallResponse): unknown {
  const item = response.contentItems[0];
  return item?.type === "text" ? (item.text.startsWith("{") ? JSON.parse(item.text) : item.text) : null;
}

const watchTwo = { group: "swarm-1", threads: [{ threadId: "child-1", label: "agent-1" }, { threadId: "child-2", label: "agent-2" }] };

describe("ThreadWatchService", () => {
  test("registers watch, unwatch and list tools in the Shepherd namespace", () => {
    const tools = harness().service.registrations();
    expect(tools.map((tool) => `${tool.namespace}.${tool.name}`)).toEqual([
      "shepherd.watch_threads", "shepherd.unwatch_threads", "shepherd.list_watched_threads",
    ]);
  });

  test("wakes the watching conversation when a watched turn completes", async () => {
    const h = harness();
    const result = await h.call("watch_threads", watchTwo);
    expect(result.success).toBe(true);
    expect(body(result)).toMatchObject({
      group: "swarm-1",
      watching: [
        { label: "agent-1", threadId: "child-1", state: "watching", turnId: null },
        { label: "agent-2", threadId: "child-2", state: "running", turnId: "turn-c2" },
      ],
    });

    h.emit("child-1", "turn.started", { turnId: "turn-c1" });
    expect(h.accepted).toHaveLength(0);
    h.emit("child-1", "turn.completed", { turnId: "turn-c1" });
    await h.flush();

    expect(h.accepted).toHaveLength(1);
    const signal = h.accepted[0]!;
    expect(signal).toMatchObject({
      envelope: { kind: THREAD_WATCH_SIGNAL_KIND, version: 1, subject: { type: "thread-watch", id: "swarm-1" } },
      target: { type: "conversation", threadId: "parent", cwd: "/work/parent", delivery: { adapter: "web", surfaceId: "handle-1" } },
      coalesceKey: "thread-watch:parent:swarm-1",
      terminal: false,
    });
    const payload = signal.envelope.payload as ThreadWatchPayload;
    expect(payload.changed).toEqual({ label: "agent-1", threadId: "child-1", state: "completed" });
    expect(payload.agents.map((agent) => [agent.label, agent.state, agent.turnId])).toEqual([
      ["agent-1", "completed", "turn-c1"],
      ["agent-2", "running", "turn-c2"],
    ]);
    const input = signal.input[0];
    expect(input?.type).toBe("text");
    const text = input?.type === "text" ? input.text : "";
    expect(text).toContain("group `swarm-1`");
    expect(text).toContain("Latest change: `agent-1` completed its turn.");
    expect(text).toContain("- `agent-2` (thread `child-2`): running");
    expect(text).toContain("untrusted claims");
  });

  test("reports interruptions, failures and pending decisions, but not failures inside a running turn", async () => {
    const h = harness();
    await h.call("watch_threads", watchTwo);
    h.emit("child-2", "turn.failed", { turnId: "turn-c2", message: "tool crashed" });
    expect(h.accepted).toHaveLength(0);

    h.threads.get("child-2")!.activeTurnId = null;
    h.emit("child-2", "turn.failed", { turnId: "turn-c2", message: "  model\n overloaded  " });
    h.emit("child-1", "turn.completed", { turnId: "turn-c1", interrupted: true });
    h.emit("child-1", "approval.requested", { kind: "question", approvalId: "a1" });
    h.emit("child-2", "approval.requested", { kind: "permission", approvalId: "a2" });
    h.emit("child-2", "session.error", { message: "app-server exited" });
    await h.flush();

    expect(h.accepted.map((signal) => (signal.envelope.payload as ThreadWatchPayload).changed.state)).toEqual([
      "failed", "interrupted", "needs-attention", "needs-attention", "failed",
    ]);
    const messages = h.accepted.map((signal) => {
      const payload = signal.envelope.payload as ThreadWatchPayload;
      return payload.agents.find((agent) => agent.threadId === payload.changed.threadId)!.message;
    });
    expect(messages).toEqual(["model overloaded", null, "waiting for an answer", "waiting for an approval", "app-server exited"]);
  });

  test("ignores events for other threads and truncates long failure messages", async () => {
    const h = harness();
    await h.call("watch_threads", { group: "g", threads: [{ threadId: "child-1", label: "a" }] });
    h.emit("child-1", "item.completed", { turnId: "t" });
    h.emit("child-1", "turn.failed", { turnId: "t", message: "x".repeat(1000) });
    await h.flush();
    expect(h.accepted).toHaveLength(1);
    const agent = (h.accepted[0]!.envelope.payload as ThreadWatchPayload).agents[0]!;
    expect(agent.message!.length).toBe(300);
    expect(agent.message!.endsWith("…")).toBe(true);
  });

  test("validates the request, its turn, its surface and the watched threads", async () => {
    const h = harness();
    const failures: Array<[JsonValue, Partial<DynamicToolCallParams>, string]> = [
      [{ group: "bad group", threads: [{ threadId: "child-1", label: "a" }] }, {}, "group must"],
      [{ group: "g", threads: [] }, {}, "threads must list"],
      [{ group: "g", threads: [{ threadId: "child-1", label: "has space" }] }, {}, "label must"],
      [{ group: "g", threads: [{ threadId: "child-1", label: "a" }, { threadId: "child-1", label: "b" }] }, {}, "listed twice"],
      [{ group: "g", threads: [{ threadId: "child-1", label: "a" }], extra: true }, {}, "Unknown watch argument: extra"],
      [{ group: "g", threads: [{ threadId: "child-1", label: "a" }], hours: 500 }, {}, "hours must"],
      [{ group: "g", threads: [{ threadId: "parent", label: "a" }] }, {}, "cannot watch itself"],
      [{ group: "g", threads: [{ threadId: "missing", label: "a" }] }, {}, "not open in Shepherd"],
      [{ group: "g", threads: [{ threadId: "child-1", label: "a" }] }, { turnId: "stale" }, "no longer belongs"],
    ];
    for (const [args, overrides, message] of failures) {
      const result = await h.call("watch_threads", args, overrides);
      expect(result.success).toBe(false);
      expect(String(body(result))).toContain(message);
    }
    h.setSurface(null);
    expect(String(body(await h.call("watch_threads", watchTwo)))).toContain("no delivery surface");
    expect(h.service.size()).toBe(0);
  });

  test("re-watching updates the label and lifetime without a second subscription", async () => {
    const h = harness();
    await h.call("watch_threads", { group: "g", threads: [{ threadId: "child-1", label: "first" }] });
    await h.call("watch_threads", { group: "g", threads: [{ threadId: "child-1", label: "second" }], hours: 48 });
    expect(h.subscribers("child-1")).toBe(1);
    h.advance(30 * 60 * 60 * 1000);
    h.emit("child-1", "turn.completed", { turnId: "t" });
    await h.flush();
    expect((h.accepted[0]!.envelope.payload as ThreadWatchPayload).changed.label).toBe("second");
  });

  test("expired watches are removed instead of signalling", async () => {
    const h = harness();
    await h.call("watch_threads", { group: "g", threads: [{ threadId: "child-1", label: "a" }], hours: 1 });
    h.advance(60 * 60 * 1000);
    h.emit("child-1", "turn.completed", { turnId: "t" });
    await h.flush();
    expect(h.accepted).toHaveLength(0);
    expect(h.service.size()).toBe(0);
    expect(h.subscribers("child-1")).toBe(0);
  });

  test("lists and removes only the calling conversation's watches", async () => {
    const h = harness();
    await h.call("watch_threads", watchTwo);
    await h.call("watch_threads", { group: "other", threads: [{ threadId: "child-3", label: "c" }] });
    h.threads.set("parent-2", { activeTurnId: "turn-q", sessionId: "s-q" });
    await h.call("watch_threads", { group: "swarm-1", threads: [{ threadId: "child-1", label: "theirs" }] }, { threadId: "parent-2", turnId: "turn-q" });
    expect(h.subscribers("child-1")).toBe(2);

    const listed = body(await h.call("list_watched_threads", {})) as { groups: Array<{ group: string; agents: unknown[] }> };
    expect(listed.groups.map((group) => [group.group, group.agents.length])).toEqual([["swarm-1", 2], ["other", 1]]);
    expect(body(await h.call("list_watched_threads", { group: "other" }))).toMatchObject({ groups: [{ group: "other" }] });

    expect(body(await h.call("unwatch_threads", { group: "swarm-1", threadIds: ["child-2"] }))).toEqual({ group: "swarm-1", removed: 1 });
    expect(body(await h.call("unwatch_threads", { group: "swarm-1" }))).toEqual({ group: "swarm-1", removed: 1 });
    expect(h.subscribers("child-1")).toBe(1);
    expect(h.service.size()).toBe(2);
    expect((await h.call("unwatch_threads", { group: "swarm-1", threadIds: "child-1" })).success).toBe(false);
  });

  test("archiving a watched conversation ends its watch silently", async () => {
    const h = harness();
    await h.call("watch_threads", watchTwo);
    h.emit("child-1", "thread.archived", {});
    await h.flush();
    expect(h.accepted).toHaveLength(0);
    expect(h.service.size()).toBe(1);
  });

  test("a watching conversation that moved away drops its group", async () => {
    const h = harness({ dispatch: "target-unavailable" });
    await h.call("watch_threads", watchTwo);
    h.emit("child-1", "turn.completed", { turnId: "t" });
    await h.flush();
    expect(h.service.size()).toBe(0);
    expect(h.subscribers("child-2")).toBe(0);
  });

  test("a saturated signal queue is reported", async () => {
    const h = harness({ dispatch: "saturated" });
    await h.call("watch_threads", watchTwo);
    h.emit("child-1", "turn.completed", { turnId: "t" });
    await h.flush();
    expect(String(h.errors[0])).toContain("Signal queue is full");
    expect(h.service.size()).toBe(2);
  });

  test("follows a resumed conversation's new session and drops detached ones", async () => {
    const h = harness();
    await h.call("watch_threads", watchTwo);
    h.threads.get("child-1")!.sessionId = "s-1-resumed";
    h.threads.delete("child-2");
    expect(h.service.size()).toBe(1);
    expect(h.subscribers("child-1")).toBe(1);
    h.emit("child-1", "turn.completed", { turnId: "t" });
    await h.flush();
    expect((h.accepted[0]!.envelope.payload as ThreadWatchPayload).agents.map((agent) => agent.label)).toEqual(["agent-1"]);
  });

  test("enforces group and total capacity", async () => {
    const h = harness({ capacity: 2, groupCapacity: 2 });
    const tooMany = await h.call("watch_threads", { group: "g", threads: [
      { threadId: "child-1", label: "a" }, { threadId: "child-2", label: "b" }, { threadId: "child-3", label: "c" },
    ] });
    expect(String(body(tooMany))).toContain("threads must list 1–2");
    expect((await h.call("watch_threads", watchTwo)).success).toBe(true);
    expect(String(body(await h.call("watch_threads", { group: "swarm-1", threads: [{ threadId: "child-3", label: "c" }] })))).toContain("at most 2");
    expect(String(body(await h.call("watch_threads", { group: "g2", threads: [{ threadId: "child-3", label: "c" }] })))).toContain("cannot watch more");
    expect((await h.call("watch_threads", { group: "swarm-1", threads: [{ threadId: "child-1", label: "renamed" }] })).success).toBe(true);
  });

  test("concurrent watch requests cannot exceed capacity together", async () => {
    const h = harness({ capacity: 2 });
    const results = await Promise.all([
      h.call("watch_threads", watchTwo),
      h.call("watch_threads", { group: "g2", threads: [{ threadId: "child-3", label: "c" }] }),
    ]);
    expect(results.map((result) => result.success)).toEqual([true, false]);
    expect(h.service.size()).toBe(2);
  });

  test("dispose releases every subscription and refuses new watches", async () => {
    const h = harness();
    await h.call("watch_threads", watchTwo);
    h.service.dispose();
    expect(h.subscribers("child-1")).toBe(0);
    expect(h.subscribers("child-2")).toBe(0);
    expect((await h.call("watch_threads", watchTwo)).success).toBe(false);
  });

  test("folds a burst of changes into one turn that reports every state", async () => {
    const turns: string[] = [];
    let releaseFirst!: () => void;
    const firstTurn = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const dispatcher = new SignalDispatcher({
      async resolveTarget(target) { return { threadId: target.threadId, cwd: target.cwd }; },
      async waitUntilIdle() {},
      async executeTurn(_target, input) {
        turns.push(input[0]?.type === "text" ? input[0].text : "");
        if (turns.length === 1) await firstTurn;
      },
    });
    const listeners = new Map<string, Listener>();
    const service = new ThreadWatchService({
      conversation: {
        getThreadState: (threadId) => ({ activeTurnId: threadId === "parent" ? "turn-p" : null, sessionId: `s-${threadId}` }),
        async getThreadCwd() { return "/work"; },
        getThreadSurface: () => ({ adapter: "discord", surfaceId: "channel" }),
        subscribeToThreadEvents(threadId, listener) { listeners.set(threadId, listener); return () => listeners.delete(threadId); },
      },
      dispatcher,
    });
    const watch = service.registrations()[0]!;
    await watch.execute({ threadId: "parent", turnId: "turn-p", callId: "c", namespace: "shepherd", tool: "watch_threads", arguments: {
      group: "swarm", threads: ["a", "b", "c"].map((label) => ({ threadId: `child-${label}`, label })),
    } });
    const complete = (label: string) => listeners.get(`child-${label}`)!({ id: label, type: "turn.completed", threadId: `child-${label}`, sessionId: "s", ts: "now", payload: { turnId: `t-${label}` } } as BridgeEvent);

    complete("a");
    await new Promise((resolve) => setTimeout(resolve, 0));
    complete("b");
    complete("c");
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(turns).toHaveLength(2);
    expect(turns[1]).toContain("Latest change: `c` completed its turn.");
    expect(turns[1]).toContain("- `b` (thread `child-b`): completed its turn");
    service.dispose();
    dispatcher.dispose();
  });
});
