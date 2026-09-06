import { describe, expect, test } from "bun:test";

import {
  SignalRouteCapacityError,
  SignalRouteRateLimitError,
  SignalRouteRegistry,
} from "../server/core/signal_route_registry.js";

const target = {
  type: "conversation" as const,
  threadId: "thread-1",
  cwd: "/workspace",
  delivery: { adapter: "discord", surfaceId: "channel-1" },
};

function request() {
  return {
    allowedSignal: { kind: "research.state-changed", version: 1 },
    target,
    originTurnId: "turn-1",
  };
}

describe("SignalRouteRegistry", () => {
  test("creates opaque routes, enforces expiry, and returns defensive copies", () => {
    let now = 1_000;
    const events: unknown[] = [];
    const registry = new SignalRouteRegistry({
      now: () => now,
      defaultTtlMs: 100,
      maxTtlMs: 200,
      generateId: () => "route_000000000000000000000000000001",
      onEvent: (event) => events.push(event),
    });
    const route = registry.create(request());
    expect(route.expiresAt).toBe(1_100);
    route.target.delivery.surfaceId = "mutated";
    expect(registry.consume(route.id)?.target.delivery.surfaceId).toBe("channel-1");

    now = 1_100;
    expect(registry.consume(route.id)).toBeNull();
    expect(registry.size()).toBe(0);
    expect(events).toEqual([
      {
        type: "created",
        routePrefix: "route_00",
        kind: "research.state-changed",
        version: 1,
      },
      {
        type: "expired",
        routePrefix: "route_00",
        kind: "research.state-changed",
        version: 1,
      },
    ]);
  });

  test("bounds capacity, requested lifetime, collisions, and request rate", () => {
    let now = 0;
    let generated = 0;
    const rateEvents: unknown[] = [];
    const registry = new SignalRouteRegistry({
      now: () => now,
      capacity: 1,
      requestsPerMinute: 2,
      defaultTtlMs: 100,
      maxTtlMs: 200,
      generateId: () => `route_${String(++generated).padStart(32, "0")}`,
      onEvent: (event) => {
        if (event.type === "rate-limited") rateEvents.push(event);
      },
    });
    const route = registry.create(request());
    expect(() => registry.create(request())).toThrow(SignalRouteCapacityError);
    expect(registry.consume(route.id)).not.toBeNull();
    expect(registry.consume(route.id)).not.toBeNull();
    expect(() => registry.consume(route.id)).toThrow(SignalRouteRateLimitError);
    expect(() => registry.consume(route.id)).toThrow(SignalRouteRateLimitError);
    expect(rateEvents).toHaveLength(1);
    now = 60_000;
    expect(registry.consume(route.id)).toBeNull();

    expect(() => new SignalRouteRegistry({
      defaultTtlMs: 100,
      maxTtlMs: 200,
      generateId: () => "short",
    }).create(request())).toThrow("invalid identifier");
    expect(() => new SignalRouteRegistry({
      defaultTtlMs: 100,
      maxTtlMs: 200,
      generateId: () => "route_000000000000000000000000000099",
    }).create({ ...request(), ttlMs: 201 })).toThrow("maximum lifetime");
  });

  test("revokes routes and clears all state on disposal", () => {
    const registry = new SignalRouteRegistry({
      generateId: () => "route_000000000000000000000000000001",
    });
    const route = registry.create(request());
    expect(registry.revoke(route.id)).toBe(true);
    expect(registry.consume(route.id)).toBeNull();
    registry.dispose();
    expect(registry.size()).toBe(0);
    expect(() => registry.create(request())).toThrow("disposed");
  });
});
