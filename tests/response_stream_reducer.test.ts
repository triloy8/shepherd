import { describe, expect, test } from "bun:test";

import { createResponseStreamState, reduceResponseStream } from "../server/core/response_stream_reducer.js";
import type { BridgeEvent } from "../shared/protocol/events.js";

function makeEvent<TPayload>(type: BridgeEvent["type"], payload: TPayload): BridgeEvent<TPayload> {
  return {
    id: "evt-1",
    type,
    threadId: "thread-1",
    sessionId: "session-1",
    ts: new Date().toISOString(),
    payload,
  };
}

describe("ResponseStreamReducer", () => {
  test("resets state on turn start", () => {
    const reduction = reduceResponseStream(
      {
        text: "existing",
        lastPhase: "final_answer",
        lastItemId: "item-1",
        commentaryOpen: false,
        commentaryLineStart: false,
      },
      makeEvent("turn.started", { turnId: "turn-1" }),
    );

    expect(reduction).toEqual({
      type: "reset",
      state: createResponseStreamState(),
    });
  });

  test("builds commentary and final answer text from deltas", () => {
    let reduction = reduceResponseStream(
      null,
      makeEvent("turn.stream.delta", {
        method: "agentMessageDelta",
        textDelta: "thinking\nmore",
        itemId: "item-1",
        phase: "commentary",
      }),
    );

    expect(reduction.type).toBe("schedule-flush");
    if (reduction.type !== "schedule-flush") throw new Error("expected schedule-flush");
    expect(reduction.state.text).toBe("\n> thinking\n> more");

    reduction = reduceResponseStream(
      reduction.state,
      makeEvent("turn.stream.delta", {
        method: "agentMessageDelta",
        textDelta: "answer",
        itemId: "item-2",
        phase: "final_answer",
      }),
    );

    expect(reduction.type).toBe("schedule-flush");
    if (reduction.type !== "schedule-flush") throw new Error("expected schedule-flush");
    expect(reduction.state.text).toBe("\n> thinking\n> more\n\nanswer");
    expect(reduction.state.lastPhase).toBe("final_answer");
  });

  test("ignores non-agent deltas", () => {
    const reduction = reduceResponseStream(
      createResponseStreamState(),
      makeEvent("turn.stream.delta", {
        method: "toolCallDelta",
        textDelta: "ignored",
        itemId: "item-1",
        phase: "commentary",
      }),
    );

    expect(reduction).toEqual({
      type: "none",
      state: createResponseStreamState(),
    });
  });

  test("closes commentary and requests immediate flush on completion", () => {
    const reduction = reduceResponseStream(
      {
        text: "\n> thinking",
        lastPhase: "commentary",
        lastItemId: "item-1",
        commentaryOpen: true,
        commentaryLineStart: false,
      },
      makeEvent("turn.completed", { turnId: "turn-1" }),
    );

    expect(reduction).toEqual({
      type: "flush-now",
      state: {
        text: "\n> thinking",
        lastPhase: "commentary",
        lastItemId: "item-1",
        commentaryOpen: false,
        commentaryLineStart: true,
      },
    });
  });
});
