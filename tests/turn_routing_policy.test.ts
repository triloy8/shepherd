import { describe, expect, test } from "bun:test";

import { classifySurfaceInput, decideTurnRouting } from "../server/core/turn_routing_policy.js";
import { toTextUserInput } from "../shared/protocol/user_input.js";

describe("TurnRoutingPolicy", () => {
  test("ignores empty surface input", () => {
    expect(
      classifySurfaceInput({
        adapter: "discord",
        surfaceId: "chan-1",
        content: "   ",
        input: [],
        isCommand: false,
        isDirectAddressed: true,
      }),
    ).toEqual({ type: "ignore" });
  });

  test("ignores non-command input that is not direct-addressed", () => {
    expect(
      classifySurfaceInput({
        adapter: "discord",
        surfaceId: "chan-1",
        content: "hello",
        input: [toTextUserInput("hello")],
        isCommand: false,
        isDirectAddressed: false,
      }),
    ).toEqual({ type: "ignore" });
  });

  test("processes command and direct-addressed surface input", () => {
    expect(
      classifySurfaceInput({
        adapter: "discord",
        surfaceId: "chan-1",
        content: " !models ",
        input: [toTextUserInput("!models")],
        isCommand: true,
        isDirectAddressed: false,
      }),
    ).toEqual({
      type: "process",
      surface: {
        adapter: "discord",
        surfaceId: "chan-1",
        content: "!models",
        input: [toTextUserInput("!models")],
        isCommand: true,
        isDirectAddressed: false,
      },
    });

    expect(
      classifySurfaceInput({
        adapter: "discord",
        surfaceId: "chan-1",
        content: "hello",
        input: [toTextUserInput("hello")],
        isCommand: false,
        isDirectAddressed: true,
      }),
    ).toEqual({
      type: "process",
      surface: {
        adapter: "discord",
        surfaceId: "chan-1",
        content: "hello",
        input: [toTextUserInput("hello")],
        isCommand: false,
        isDirectAddressed: true,
      },
    });
  });

  test("ignores handled command results", () => {
    expect(
      decideTurnRouting({
        handled: true,
        surface: {
          adapter: "discord",
          surfaceId: "chan-1",
          content: "hello",
          input: [toTextUserInput("hello")],
          isCommand: true,
          isDirectAddressed: false,
        },
        threadId: "thread-1",
        input: [toTextUserInput("hello")],
        activeTurnId: null,
        approvalPolicy: "on-request",
      }),
    ).toEqual({ type: "ignore" });
  });

  test("ignores results without a thread or input", () => {
    expect(
      decideTurnRouting({
        handled: false,
        surface: {
          adapter: "discord",
          surfaceId: "chan-1",
          content: "hello",
          input: [toTextUserInput("hello")],
          isCommand: false,
          isDirectAddressed: true,
        },
        threadId: null,
        input: [toTextUserInput("hello")],
        activeTurnId: null,
        approvalPolicy: "on-request",
      }),
    ).toEqual({ type: "ignore" });

    expect(
      decideTurnRouting({
        handled: false,
        surface: {
          adapter: "discord",
          surfaceId: "chan-1",
          content: "hello",
          input: [toTextUserInput("hello")],
          isCommand: false,
          isDirectAddressed: true,
        },
        threadId: "thread-1",
        input: null,
        activeTurnId: null,
        approvalPolicy: "on-request",
      }),
    ).toEqual({ type: "ignore" });
  });

  test("steers direct-addressed input into the active turn", () => {
    expect(
      decideTurnRouting({
        handled: false,
        surface: {
          adapter: "discord",
          surfaceId: "chan-1",
          content: "continue",
          input: [toTextUserInput("continue")],
          isCommand: false,
          isDirectAddressed: true,
        },
        threadId: "thread-1",
        input: [toTextUserInput("continue")],
        activeTurnId: "turn-1",
        approvalPolicy: "on-request",
      }),
    ).toEqual({
      type: "steer",
      threadId: "thread-1",
      input: [toTextUserInput("continue")],
      turnId: "turn-1",
    });
  });

  test("submits direct-addressed input when no turn is active", () => {
    expect(
      decideTurnRouting({
        handled: false,
        surface: {
          adapter: "discord",
          surfaceId: "chan-1",
          content: "continue",
          input: [toTextUserInput("continue")],
          isCommand: false,
          isDirectAddressed: true,
        },
        threadId: "thread-1",
        input: [toTextUserInput("continue")],
        activeTurnId: null,
        approvalPolicy: "never",
      }),
    ).toEqual({
      type: "submit",
      threadId: "thread-1",
      input: [toTextUserInput("continue")],
      approvalPolicy: "never",
    });
  });

  test("submits non-command input when not direct-addressed but already accepted upstream", () => {
    expect(
      decideTurnRouting({
        handled: false,
        surface: {
          adapter: "discord",
          surfaceId: "chan-1",
          content: "continue",
          input: [toTextUserInput("continue")],
          isCommand: false,
          isDirectAddressed: false,
        },
        threadId: "thread-1",
        input: [toTextUserInput("continue")],
        activeTurnId: "turn-1",
        approvalPolicy: "on-request",
      }),
    ).toEqual({
      type: "submit",
      threadId: "thread-1",
      input: [toTextUserInput("continue")],
      approvalPolicy: "on-request",
    });
  });

  test("processes image-only input when directly addressed", () => {
    expect(
      classifySurfaceInput({
        adapter: "discord",
        surfaceId: "chan-1",
        content: "",
        input: [{ type: "image", url: "https://example.com/image.png" }],
        isCommand: false,
        isDirectAddressed: true,
      }),
    ).toEqual({
      type: "process",
      surface: {
        adapter: "discord",
        surfaceId: "chan-1",
        content: "",
        input: [{ type: "image", url: "https://example.com/image.png" }],
        isCommand: false,
        isDirectAddressed: true,
      },
    });
  });
});
