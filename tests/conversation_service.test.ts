import { describe, expect, test } from "bun:test";

import { ConversationService } from "../server/core/conversation_service.js";
import type { BridgeEvent } from "../shared/protocol/events.js";

type FakeManager = {
  subscribeToThreadEvents: (
    threadId: string,
    listener: (event: BridgeEvent) => void,
    cursorOrOptions?: string | { afterId?: string; replay?: boolean },
  ) => () => void;
};

type FakeRouting = {
  getDefaultThread: (adapter: string, surfaceId: string) => string | null;
  setDefaultThread: (adapter: string, surfaceId: string, threadId: string) => Promise<string>;
  clearDefaultThread: (adapter: string, surfaceId: string) => void;
  resolveRoute: (input: {
    adapter: string;
    surfaceId: string;
    explicitThreadId?: string;
    autoCreateIfMissing?: boolean;
    approvalPolicyHint?: "untrusted" | "on-failure" | "on-request" | "never";
  }) => Promise<{
    threadId: string;
    created: boolean;
    resumed: boolean;
    reason: "explicit" | "default" | "auto-created";
  }>;
};

function makeServiceHarness() {
  const surfaceThreads = new Map<string, string | null>();
  const subscribeCalls: Array<{ threadId: string; cursorOrOptions: unknown }> = [];
  let unsubscribeCalls = 0;

  const manager: FakeManager = {
    subscribeToThreadEvents(threadId, _listener, cursorOrOptions) {
      subscribeCalls.push({ threadId, cursorOrOptions });
      return () => {
        unsubscribeCalls += 1;
      };
    },
  };

  const routing: FakeRouting = {
    getDefaultThread(adapter, surfaceId) {
      return surfaceThreads.get(`${adapter}:${surfaceId}`) ?? null;
    },
    async setDefaultThread(adapter, surfaceId, threadId) {
      surfaceThreads.set(`${adapter}:${surfaceId}`, threadId);
      return threadId;
    },
    clearDefaultThread(adapter, surfaceId) {
      surfaceThreads.set(`${adapter}:${surfaceId}`, null);
    },
    async resolveRoute(input) {
      const key = `${input.adapter}:${input.surfaceId}`;
      const current = surfaceThreads.get(key) ?? null;
      const threadId = input.explicitThreadId ?? current ?? "auto-thread";
      surfaceThreads.set(key, threadId);
      return {
        threadId,
        created: !current,
        resumed: false,
        reason: input.explicitThreadId ? "explicit" : current ? "default" : "auto-created",
      };
    },
  };

  const service = new ConversationService() as unknown as {
    manager: FakeManager;
    routing: FakeRouting;
  } & ConversationService;

  service.manager = manager;
  service.routing = routing;

  return {
    service,
    subscribeCalls,
    getUnsubscribeCalls: () => unsubscribeCalls,
  };
}

describe("ConversationService surface subscriptions", () => {
  test("bind re-subscribes from old thread to new thread", async () => {
    const h = makeServiceHarness();

    h.service.subscribeSurfaceEvents("discord", "chan-1", () => undefined, { replay: false });
    expect(h.subscribeCalls).toHaveLength(0);

    await h.service.bindSurfaceToThread("discord", "chan-1", "thread-a");
    expect(h.subscribeCalls).toHaveLength(1);
    expect(h.subscribeCalls[0]?.threadId).toBe("thread-a");

    await h.service.bindSurfaceToThread("discord", "chan-1", "thread-b");
    expect(h.getUnsubscribeCalls()).toBe(1);
    expect(h.subscribeCalls).toHaveLength(2);
    expect(h.subscribeCalls[1]?.threadId).toBe("thread-b");
  });

  test("bind to same thread does not duplicate subscription", async () => {
    const h = makeServiceHarness();

    h.service.subscribeSurfaceEvents("discord", "chan-1", () => undefined, { replay: false });
    await h.service.bindSurfaceToThread("discord", "chan-1", "thread-a");
    await h.service.bindSurfaceToThread("discord", "chan-1", "thread-a");

    expect(h.subscribeCalls).toHaveLength(1);
    expect(h.getUnsubscribeCalls()).toBe(0);
  });

  test("clear surface binding unsubscribes existing surface stream", async () => {
    const h = makeServiceHarness();

    h.service.subscribeSurfaceEvents("discord", "chan-1", () => undefined, { replay: false });
    await h.service.bindSurfaceToThread("discord", "chan-1", "thread-a");

    h.service.clearSurfaceBinding("discord", "chan-1");
    expect(h.getUnsubscribeCalls()).toBe(1);
  });

  test("replacing surface listener unsubscribes prior listener", async () => {
    const h = makeServiceHarness();

    await h.service.bindSurfaceToThread("discord", "chan-1", "thread-a");
    h.service.subscribeSurfaceEvents("discord", "chan-1", () => undefined, { replay: false });
    h.service.subscribeSurfaceEvents("discord", "chan-1", () => undefined, { replay: false });

    expect(h.subscribeCalls).toHaveLength(2);
    expect(h.getUnsubscribeCalls()).toBe(1);
  });
});
