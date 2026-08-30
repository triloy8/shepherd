import { afterEach, describe, expect, test } from "bun:test";

import { toTextUserInput } from "../shared/protocol/user_input.js";
import type { SignalDispatchResult } from "../server/core/signal_dispatcher.js";
import { SignalRegistry, type RegisteredSignal } from "../server/core/signal_registry.js";
import {
  startWebhookSignalServer,
  type WebhookSignalServer,
} from "../server/adapters/webhook/server.js";

const servers: WebhookSignalServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

function makeRegistry(): SignalRegistry {
  const registry = new SignalRegistry();
  registry.register({
    kind: "build.finished",
    version: 1,
    target: { type: "surface", adapter: "discord", surfaceId: "channel-1" },
    validatePayload(value) {
      if (!value || typeof value !== "object" || typeof (value as { status?: unknown }).status !== "string") {
        throw new Error("Build status is required.");
      }
      return { status: (value as { status: string }).status };
    },
    buildInput: (signal) => [toTextUserInput(`Build ${signal.subject?.id}: ${signal.payload.status}`)],
    coalesceKey: (signal) => signal.subject?.id ?? "builds",
  });
  return registry;
}

function start(options: {
  result?: SignalDispatchResult;
  token?: string;
  maxBodyBytes?: number;
  available?: boolean;
  accepted?: RegisteredSignal[];
} = {}): WebhookSignalServer {
  const server = startWebhookSignalServer({
    registry: makeRegistry(),
    dispatcher: {
      async accept(signal) {
        options.accepted?.push(signal);
        return options.result ?? { type: "accepted", threadId: "thread-1" };
      },
    },
    hostname: "127.0.0.1",
    port: 0,
    bearerToken: options.token,
    maxBodyBytes: options.maxBodyBytes,
    isAvailable: () => options.available ?? true,
  });
  servers.push(server);
  return server;
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
  test("accepts and resolves a typed signal", async () => {
    const accepted: RegisteredSignal[] = [];
    const server = start({ accepted });
    const response = await fetch(`${server.url}/signals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody()),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true, coalesced: false, threadId: "thread-1" });
    expect(accepted[0]?.coalesceKey).toBe("build.finished@1:build-1");
  });

  test("maps dispatcher outcomes to explicit status codes", async () => {
    const cases: Array<[SignalDispatchResult, number]> = [
      [{ type: "coalesced", threadId: "thread-1" }, 202],
      [{ type: "saturated" }, 429],
      [{ type: "target-unavailable" }, 409],
      [{ type: "unavailable" }, 503],
    ];

    for (const [result, expectedStatus] of cases) {
      const server = start({ result });
      const response = await fetch(`${server.url}/signals`, {
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
    const server = start();
    const request = (body: unknown, contentType = "application/json") =>
      fetch(`${server.url}/signals`, {
        method: "POST",
        headers: { "content-type": contentType },
        body: JSON.stringify(body),
      });

    expect((await request({ ...validBody(), kind: "unknown.signal" })).status).toBe(404);
    expect((await request({ ...validBody(), version: 2 })).status).toBe(400);
    expect((await request({ ...validBody(), payload: {} })).status).toBe(400);
    expect((await request(validBody(), "text/plain")).status).toBe(415);
  });

  test("enforces bearer authentication and body limits", async () => {
    const server = start({ token: "secret", maxBodyBytes: 32 });
    const unauthorized = await fetch(`${server.url}/signals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody()),
    });
    expect(unauthorized.status).toBe(401);

    const oversized = await fetch(`${server.url}/signals`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
      },
      body: JSON.stringify(validBody()),
    });
    expect(oversized.status).toBe(413);
  });

  test("reports health and quiescing without accepting a signal", async () => {
    const accepted: RegisteredSignal[] = [];
    const server = start({ available: false, accepted });

    expect((await fetch(`${server.url}/health`)).status).toBe(503);
    const response = await fetch(`${server.url}/signals`, {
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
        dispatcher: { async accept() { return { type: "unavailable" }; } },
        hostname: "0.0.0.0",
      }),
    ).toThrow("must bind to loopback");
  });
});
