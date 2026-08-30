import { describe, expect, test } from "bun:test";

import { toTextUserInput } from "../shared/protocol/user_input.js";
import {
  InvalidSignalError,
  SignalRegistry,
  UnknownSignalKindError,
  UnsupportedSignalVersionError,
} from "../server/core/signal_registry.js";

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

describe("SignalRegistry", () => {
  test("validates an envelope and resolves its kind definition", () => {
    const resolved = makeRegistry().resolve({
      kind: "build.finished",
      version: 1,
      subject: { type: "build", id: "build-1" },
      payload: { status: "failed" },
    });

    expect(resolved.coalesceKey).toBe("build.finished@1:build-1");
    expect(resolved.input).toEqual([toTextUserInput("Build build-1: failed")]);
    expect(resolved.target.surfaceId).toBe("channel-1");
  });

  test("rejects malformed envelopes and kind-specific payloads", () => {
    const registry = makeRegistry();
    expect(() => registry.resolve({ kind: "Build", version: 1, payload: {} })).toThrow(InvalidSignalError);
    expect(() => registry.resolve({ kind: "build.finished", version: 1, payload: {} })).toThrow(
      "Build status is required.",
    );
    expect(() =>
      registry.resolve({ kind: "build.finished", version: 1, payload: { status: "ok" }, extra: true }),
    ).toThrow("Unknown signal field: extra.");
  });

  test("distinguishes unknown kinds from unsupported versions", () => {
    const registry = makeRegistry();
    expect(() => registry.resolve({ kind: "dataset.ready", version: 1, payload: {} })).toThrow(
      UnknownSignalKindError,
    );
    expect(() => registry.resolve({ kind: "build.finished", version: 2, payload: {} })).toThrow(
      UnsupportedSignalVersionError,
    );
  });

  test("rejects duplicate registrations", () => {
    const registry = makeRegistry();
    expect(() =>
      registry.register({
        kind: "build.finished",
        version: 1,
        target: { type: "surface", adapter: "discord", surfaceId: "channel-2" },
        validatePayload: (value) => value,
        buildInput: () => [toTextUserInput("duplicate")],
      }),
    ).toThrow("already registered");
  });
});
