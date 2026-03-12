import { describe, expect, test } from "bun:test";

import { executeTurnRouting } from "../server/core/turn_routing_service.js";

function makeInput(overrides?: Partial<Parameters<typeof executeTurnRouting>[1]>) {
  return {
    surface: {
      adapter: "discord",
      surfaceId: "chan-1",
      content: "hello",
      isCommand: false,
      isDirectAddressed: true,
    },
    handled: false,
    threadId: "thread-1",
    input: "hello",
    approvalPolicy: "on-request" as const,
    ...overrides,
  };
}

describe("TurnRoutingService", () => {
  test("ignores handled inputs without calling conversation", async () => {
    let calls = 0;
    const result = await executeTurnRouting(
      {
        conversation: {
          getThreadState() {
            calls += 1;
            return { threadId: "thread-1", sessionId: "session-1", activeTurnId: null, approvalPolicy: "on-request" };
          },
          async submitTurn() {
            calls += 1;
            return { ok: true, turnId: "turn-1" };
          },
          async steerTurn() {
            calls += 1;
            return { ok: true, turnId: "turn-1" };
          },
        },
      },
      makeInput({ handled: true }),
    );

    expect(result).toEqual({ type: "ignore" });
    expect(calls).toBe(1);
  });

  test("submits turns when there is no active turn", async () => {
    const submits: Array<{ threadId: string; input: string; approvalPolicy?: string }> = [];
    const result = await executeTurnRouting(
      {
        conversation: {
          getThreadState() {
            return { threadId: "thread-1", sessionId: "session-1", activeTurnId: null, approvalPolicy: "on-request" };
          },
          async submitTurn(threadId, request) {
            submits.push({ threadId, input: request.input, approvalPolicy: request.approvalPolicy });
            return { ok: true, turnId: "turn-submit" };
          },
          async steerTurn() {
            throw new Error("unexpected steer");
          },
        },
      },
      makeInput(),
    );

    expect(result).toEqual({ type: "submit", threadId: "thread-1", turnId: "turn-submit" });
    expect(submits).toEqual([{ threadId: "thread-1", input: "hello", approvalPolicy: "on-request" }]);
  });

  test("steers direct-addressed input into the active turn", async () => {
    const steers: Array<{ threadId: string; input: string; turnId?: string }> = [];
    const result = await executeTurnRouting(
      {
        conversation: {
          getThreadState() {
            return { threadId: "thread-1", sessionId: "session-1", activeTurnId: "turn-active", approvalPolicy: "on-request" };
          },
          async submitTurn() {
            throw new Error("unexpected submit");
          },
          async steerTurn(threadId, request) {
            steers.push({ threadId, input: request.input, turnId: request.turnId });
            return { ok: true, turnId: "turn-active" };
          },
        },
      },
      makeInput(),
    );

    expect(result).toEqual({ type: "steer", threadId: "thread-1", turnId: "turn-active" });
    expect(steers).toEqual([{ threadId: "thread-1", input: "hello", turnId: "turn-active" }]);
  });

  test("submits command input even when a turn is active", async () => {
    const submits: Array<{ threadId: string; input: string }> = [];
    const result = await executeTurnRouting(
      {
        conversation: {
          getThreadState() {
            return { threadId: "thread-1", sessionId: "session-1", activeTurnId: "turn-active", approvalPolicy: "on-request" };
          },
          async submitTurn(threadId, request) {
            submits.push({ threadId, input: request.input });
            return { ok: true, turnId: "turn-submit" };
          },
          async steerTurn() {
            throw new Error("unexpected steer");
          },
        },
      },
      makeInput({
        surface: {
          adapter: "discord",
          surfaceId: "chan-1",
          content: "!models",
          isCommand: true,
          isDirectAddressed: false,
        },
        input: "!models",
      }),
    );

    expect(result).toEqual({ type: "submit", threadId: "thread-1", turnId: "turn-submit" });
    expect(submits).toEqual([{ threadId: "thread-1", input: "!models" }]);
  });
});
