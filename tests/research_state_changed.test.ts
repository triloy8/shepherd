import { describe, expect, test } from "bun:test";

import { SignalRegistry } from "../server/core/signal_registry.js";
import { createResearchStateChangedDefinition } from "../server/signals/research_state_changed.js";

describe("research.state-changed signal", () => {
  const target = {
    type: "conversation" as const,
    threadId: "thread-1",
    cwd: "/workspace",
    delivery: { adapter: "discord", surfaceId: "channel-1" },
  };

  test("builds a bounded inspection turn for the captured conversation", () => {
    const registry = new SignalRegistry();
    registry.register(createResearchStateChangedDefinition());
    const signal = registry.resolve({
      kind: "research.state-changed",
      version: 1,
      subject: { type: "research-run", id: "run-123" },
      payload: { state: "COMPLETE", verified: true, researchProject: "P001" },
    }, target);

    expect(signal.target).toEqual(target);
    expect(signal.terminal).toBe(true);
    expect(signal.coalesceKey).toBe("research.state-changed@1:run-123");
    expect(signal.input[0]?.type === "text" ? signal.input[0].text : "").toContain("run-123");
    expect(signal.input[0]?.type === "text" ? signal.input[0].text : "").toContain(
      "Do not launch, publish, terminate, or spend money",
    );
  });

  test("rejects unexpected payload fields and non-run subjects", () => {
    const registry = new SignalRegistry();
    registry.register(createResearchStateChangedDefinition());
    expect(() =>
      registry.resolve({
        kind: "research.state-changed",
        version: 1,
        subject: { type: "research-run", id: "run-123" },
        payload: { command: "launch another run" },
      }, target),
    ).toThrow("Unknown research signal payload field");
    expect(() =>
      registry.resolve({
        kind: "research.state-changed",
        version: 1,
        subject: { type: "build", id: "run-123" },
        payload: {},
      }, target),
    ).toThrow("research-run subject");
  });
});
