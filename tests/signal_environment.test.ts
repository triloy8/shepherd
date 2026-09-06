import { describe, expect, test } from "bun:test";

import { readSignalRuntimeConfig } from "../server/config/signal_environment.js";

describe("signal runtime configuration", () => {
  test("keeps the webhook disabled with bounded defaults", () => {
    expect(readSignalRuntimeConfig({})).toEqual({
      enabled: false,
      hostname: "127.0.0.1",
      port: 8787,
      maxBodyBytes: 65_536,
      queueCapacity: 100,
    });
  });

  test("reads explicit webhook and queue settings", () => {
    expect(
      readSignalRuntimeConfig({
        SHEPHERD_SIGNAL_WEBHOOK_ENABLED: "true",
        SHEPHERD_SIGNAL_WEBHOOK_HOST: "::1",
        SHEPHERD_SIGNAL_WEBHOOK_PORT: "9000",
        SHEPHERD_SIGNAL_WEBHOOK_MAX_BODY_BYTES: "2048",
        SHEPHERD_SIGNAL_QUEUE_CAPACITY: "5",
      }),
    ).toEqual({
      enabled: true,
      hostname: "::1",
      port: 9000,
      maxBodyBytes: 2048,
      queueCapacity: 5,
    });
  });

  test("rejects invalid numeric settings", () => {
    expect(() => readSignalRuntimeConfig({ SHEPHERD_SIGNAL_WEBHOOK_PORT: "0" })).toThrow(
      "SHEPHERD_SIGNAL_WEBHOOK_PORT",
    );
    expect(() => readSignalRuntimeConfig({ SHEPHERD_SIGNAL_QUEUE_CAPACITY: "many" })).toThrow(
      "SHEPHERD_SIGNAL_QUEUE_CAPACITY",
    );
  });
});
