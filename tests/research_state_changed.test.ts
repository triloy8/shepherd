import { describe, expect, test } from "bun:test";

import { SignalRegistry } from "../server/core/signal_registry.js";
import { createResearchStateChangedDefinition } from "../server/signals/research_state_changed.js";

describe("research.state-changed signal", () => {
  test("builds a bounded inspection turn for the configured surface", () => {
    const registry = new SignalRegistry();
    registry.register(createResearchStateChangedDefinition("channel-1"));
    const signal = registry.resolve({
      kind: "research.state-changed",
      version: 1,
      subject: { type: "research-run", id: "run-123" },
      payload: { state: "COMPLETE", verified: true, researchProject: "P001" },
    });

    expect(signal.target).toEqual({ type: "surface", adapter: "discord", surfaceId: "channel-1" });
    expect(signal.coalesceKey).toBe("research.state-changed@1:run-123");
    expect(signal.input[0]?.type === "text" ? signal.input[0].text : "").toContain("run-123");
    expect(signal.input[0]?.type === "text" ? signal.input[0].text : "").toContain(
      "Do not launch, publish, terminate, or spend money",
    );
  });

  test("rejects unexpected payload fields and non-run subjects", () => {
    const registry = new SignalRegistry();
    registry.register(createResearchStateChangedDefinition("channel-1"));
    expect(() =>
      registry.resolve({
        kind: "research.state-changed",
        version: 1,
        subject: { type: "research-run", id: "run-123" },
        payload: { command: "launch another run" },
      }),
    ).toThrow("Unknown research signal payload field");
    expect(() =>
      registry.resolve({
        kind: "research.state-changed",
        version: 1,
        subject: { type: "build", id: "run-123" },
        payload: {},
      }),
    ).toThrow("research-run subject");
  });
});
