import { describe, expect, test } from "bun:test";

import { decideTurnRouting } from "../server/core/turn_routing_policy.js";

describe("TurnRoutingPolicy", () => {
  test("ignores handled command results", () => {
    expect(
      decideTurnRouting({
        handled: true,
        threadId: "thread-1",
        input: "hello",
        isCommand: true,
        isDirectAddressed: false,
        activeTurnId: null,
        approvalPolicy: "on-request",
      }),
    ).toEqual({ type: "ignore" });
  });

  test("ignores results without a thread or input", () => {
    expect(
      decideTurnRouting({
        handled: false,
        threadId: null,
        input: "hello",
        isCommand: false,
        isDirectAddressed: true,
        activeTurnId: null,
        approvalPolicy: "on-request",
      }),
    ).toEqual({ type: "ignore" });

    expect(
      decideTurnRouting({
        handled: false,
        threadId: "thread-1",
        input: null,
        isCommand: false,
        isDirectAddressed: true,
        activeTurnId: null,
        approvalPolicy: "on-request",
      }),
    ).toEqual({ type: "ignore" });
  });

  test("steers direct-addressed input into the active turn", () => {
    expect(
      decideTurnRouting({
        handled: false,
        threadId: "thread-1",
        input: "continue",
        isCommand: false,
        isDirectAddressed: true,
        activeTurnId: "turn-1",
        approvalPolicy: "on-request",
      }),
    ).toEqual({
      type: "steer",
      threadId: "thread-1",
      input: "continue",
      turnId: "turn-1",
    });
  });

  test("submits direct-addressed input when no turn is active", () => {
    expect(
      decideTurnRouting({
        handled: false,
        threadId: "thread-1",
        input: "continue",
        isCommand: false,
        isDirectAddressed: true,
        activeTurnId: null,
        approvalPolicy: "never",
      }),
    ).toEqual({
      type: "submit",
      threadId: "thread-1",
      input: "continue",
      approvalPolicy: "never",
    });
  });

  test("submits non-command input when not direct-addressed but already accepted upstream", () => {
    expect(
      decideTurnRouting({
        handled: false,
        threadId: "thread-1",
        input: "continue",
        isCommand: false,
        isDirectAddressed: false,
        activeTurnId: "turn-1",
        approvalPolicy: "on-request",
      }),
    ).toEqual({
      type: "submit",
      threadId: "thread-1",
      input: "continue",
      approvalPolicy: "on-request",
    });
  });
});
