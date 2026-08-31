import { afterEach, describe, expect, test } from "bun:test";

import { toTextUserInput } from "../shared/protocol/user_input.js";
import type { SignalDispatchResult } from "../server/core/signal_dispatcher.js";
import { SignalRegistry, type RegisteredSignal } from "../server/core/signal_registry.js";
import { SignalRouteRegistry } from "../server/core/signal_route_registry.js";
import {
  startWebhookSignalServer,
  type WebhookSignalServer,
} from "../server/adapters/webhook/server.js";

const servers: WebhookSignalServer[] = [];
const target = {
  type: "conversation" as const,
  threadId: "thread-1",
  cwd: "/workspace",
  delivery: { adapter: "discord", surfaceId: "channel-1" },
};
let routeSequence = 0;

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

function makeRegistry(): SignalRegistry {
  const registry = new SignalRegistry();
  registry.register({
    kind: "build.finished",
    version: 1,
    validatePayload(value) {
      if (!value || typeof value !== "object" || typeof (value as { status?: unknown }).status !== "string") {
        throw new Error("Build status is required.");
      }
      return { status: (value as { status: string }).status };
    },
    buildInput: (signal) => [toTextUserInput(`Build ${signal.subject?.id}: ${signal.payload.status}`)],
    coalesceKey: (signal) => signal.subject?.id ?? "builds",
    isTerminal: (signal) => signal.payload.status === "complete",
  });
  return registry;
}

function start(options: {
  result?: SignalDispatchResult;
  maxBodyBytes?: number;
  available?: boolean;
  accepted?: RegisteredSignal[];
} = {}): { server: WebhookSignalServer; routeUrl: string; routes: SignalRouteRegistry } {
  const routes = new SignalRouteRegistry({
    generateId: () => `route_${String(++routeSequence).padStart(32, "0")}`,
  });
  const route = routes.create({
    allowedSignal: { kind: "build.finished", version: 1 },
    target,
    originTurnId: "turn-origin",
  });
  const server = startWebhookSignalServer({
    registry: makeRegistry(),
    routes,
    dispatcher: {
      async accept(signal) {
        options.accepted?.push(signal);
        return options.result ?? { type: "accepted", threadId: "thread-1" };
      },
    },
    hostname: "127.0.0.1",
    port: 0,
    maxBodyBytes: options.maxBodyBytes,
    isAvailable: () => options.available ?? true,
  });
  servers.push(server);
  return { server, routes, routeUrl: `${server.url}/signals/${route.id}` };
}

function validBody(): Record<string, unknown> {
  return {
    kind: "build.finished",
    version: 1,
    subject: { type: "build", id: "build-1" },
    payload: { status: "failed" },
  };
}

describe("webhook signal server", () => {
  test("accepts and resolves an unauthenticated typed signal", async () => {
    const accepted: RegisteredSignal[] = [];
    const { server, routeUrl } = start({ accepted });
    const response = await fetch(routeUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody()),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true, coalesced: false });
    expect(accepted[0]?.coalesceKey).toContain("build.finished@1:build-1");
    expect(await fetch(`${server.url}/signals`, { method: "POST" }).then((item) => item.status)).toBe(404);
  });

  test("maps dispatcher outcomes to explicit status codes", async () => {
    const cases: Array<[SignalDispatchResult, number]> = [
      [{ type: "coalesced", threadId: "thread-1" }, 202],
      [{ type: "saturated" }, 429],
      [{ type: "target-unavailable" }, 409],
      [{ type: "unavailable" }, 503],
    ];

    for (const [result, expectedStatus] of cases) {
      const { server, routeUrl } = start({ result });
      const response = await fetch(routeUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validBody()),
      });
      expect(response.status).toBe(expectedStatus);
      await server.stop();
      servers.splice(servers.indexOf(server), 1);
    }
  });

  test("rejects unknown kinds, versions, invalid payloads, and content types", async () => {
    const { routeUrl } = start();
    const request = (body: unknown, contentType = "application/json") =>
      fetch(routeUrl, {
        method: "POST",
        headers: { "content-type": contentType },
        body: JSON.stringify(body),
      });

    expect((await request({ ...validBody(), kind: "unknown.signal" })).status).toBe(404);
    expect((await request({ ...validBody(), version: 2 })).status).toBe(404);
    expect((await request({ ...validBody(), payload: {} })).status).toBe(400);
    expect((await request(validBody(), "text/plain")).status).toBe(415);
  });

  test("enforces body limits", async () => {
    const { routeUrl } = start({ maxBodyBytes: 32 });
    const oversized = await fetch(routeUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody()),
    });
    expect(oversized.status).toBe(413);
  });

  test("revokes a route only after accepting a terminal signal", async () => {
    const { routeUrl } = start();
    const response = await fetch(routeUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...validBody(),
        payload: { status: "complete" },
      }),
    });
    expect(response.status).toBe(202);
    expect((await fetch(routeUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody()),
    })).status).toBe(404);
  });

  test("reports health and quiescing without accepting a signal", async () => {
    const accepted: RegisteredSignal[] = [];
    const { server, routeUrl } = start({ available: false, accepted });

    expect((await fetch(`${server.url}/health`)).status).toBe(503);
    const response = await fetch(routeUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody()),
    });
    expect(response.status).toBe(503);
    expect(accepted).toEqual([]);
  });

  test("rejects non-loopback binding by default", () => {
    expect(() =>
      startWebhookSignalServer({
        registry: makeRegistry(),
        routes: new SignalRouteRegistry(),
        dispatcher: { async accept() { return { type: "unavailable" }; } },
        hostname: "0.0.0.0",
      }),
    ).toThrow("must bind to loopback");
  });
});
