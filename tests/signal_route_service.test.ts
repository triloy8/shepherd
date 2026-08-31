import { describe, expect, test } from "bun:test";

import type { DynamicToolCallParams } from "../shared/protocol/dynamic_tools.js";
import { SignalRouteRegistry } from "../server/core/signal_route_registry.js";
import { SignalRouteService } from "../server/core/signal_route_service.js";
import { SignalRegistry } from "../server/core/signal_registry.js";
import { createResearchStateChangedDefinition } from "../server/signals/research_state_changed.js";

function params(overrides: Partial<DynamicToolCallParams> = {}): DynamicToolCallParams {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    callId: "call-1",
    namespace: "shepherd",
    tool: "get_signal_callback",
    arguments: { kind: "research.state-changed", version: 1 },
    ...overrides,
  };
}

function harness(options: { activeTurnId?: string | null; surface?: boolean; capacity?: number } = {}) {
  let generated = 0;
  const routes = new SignalRouteRegistry({
    capacity: options.capacity,
    generateId: () => `route_${String(++generated).padStart(32, "0")}`,
  });
  const signals = new SignalRegistry();
  signals.register(createResearchStateChangedDefinition());
  const service = new SignalRouteService({
    routes,
    signals,
    conversation: {
      getThreadState(threadId) {
        if (threadId === "missing") throw new Error("missing");
        return {
          threadId,
          sessionId: "session-1",
          activeTurnId: options.activeTurnId === undefined ? "turn-1" : options.activeTurnId,
          approvalPolicy: "on-request",
        };
      },
      async getThreadCwd() { return "/workspace"; },
      getThreadSurface() {
        return options.surface === false ? null : { adapter: "discord", surfaceId: "channel-1" };
      },
    },
    getWebhookBaseUrl: () => "http://127.0.0.1:8787/",
  });
  return { routes, execute: service.registration().execute };
}

describe("SignalRouteService", () => {
  test("allocates a fresh route captured from the active tool-call conversation", async () => {
    const { routes, execute } = harness();
    const first = await execute(params());
    const second = await execute(params({ callId: "call-2" }));

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(first.contentItems[0]).not.toEqual(second.contentItems[0]);
    const text = first.contentItems[0]?.type === "inputText" ? first.contentItems[0].text : "";
    const url = JSON.parse(text) as { url: string };
    const routeId = url.url.split("/").at(-1) as string;
    expect(url.url).toBe(`http://127.0.0.1:8787/signals/${routeId}`);
    expect(routes.consume(routeId)).toMatchObject({
      originTurnId: "turn-1",
      allowedSignal: { kind: "research.state-changed", version: 1 },
      target: {
        threadId: "thread-1",
        cwd: "/workspace",
        delivery: { adapter: "discord", surfaceId: "channel-1" },
      },
    });
  });

  test("returns tool failures for unsupported, stale, or undeliverable requests", async () => {
    await expect(harness().execute(params({
      arguments: { kind: "unknown.signal", version: 1 },
    }))).resolves.toMatchObject({ success: false });
    await expect(harness({ activeTurnId: "turn-2" }).execute(params())).resolves.toEqual({
      success: false,
      contentItems: [{ type: "inputText", text: "The callback request no longer belongs to the active turn." }],
    });
    await expect(harness({ surface: false }).execute(params())).resolves.toMatchObject({ success: false });
  });

  test("fails cleanly when route capacity is exhausted", async () => {
    const { execute } = harness({ capacity: 1 });
    expect((await execute(params())).success).toBe(true);
    expect(await execute(params({ callId: "call-2" }))).toEqual({
      success: false,
      contentItems: [{ type: "inputText", text: "Shepherd cannot allocate another callback route right now." }],
    });
  });
});
