import { describe, expect, test } from "bun:test";

import {
  createResponseStreamState,
  getFinalResponseText,
  reduceResponseStream,
} from "../server/core/response_stream_reducer.js";
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

function delta(
  textDelta: string,
  phase: "commentary" | "final_answer",
  itemId: string,
  turnId = "turn-1",
): BridgeEvent {
  return makeEvent("turn.stream.delta", {
    method: "item/agentMessage/delta",
    textDelta,
    itemId,
    phase,
    turnId,
  });
}

describe("ResponseStreamReducer", () => {
  test("resets all output state for a new turn", () => {
    const reduction = reduceResponseStream(
      {
        turnId: "turn-old",
        finalMessages: [{ itemId: "final-old", text: "existing" }],
        activeCommentary: { itemId: "comment-old", text: "thinking" },
      },
      makeEvent("turn.started", { turnId: "turn-1" }),
    );

    expect(reduction).toEqual({
      type: "reset",
      state: createResponseStreamState("turn-1"),
    });
  });

  test("keeps commentary independent from the final answer", () => {
    let reduction = reduceResponseStream(null, delta("thinking\nmore", "commentary", "comment-1"));
    expect(reduction.type).toBe("updated");
    if (reduction.type !== "updated") throw new Error("expected update");
    expect(reduction.state.activeCommentary?.text).toBe("thinking\nmore");
    expect(getFinalResponseText(reduction.state)).toBe("");

    reduction = reduceResponseStream(reduction.state, delta("answer", "final_answer", "final-1"));
    expect(reduction.type).toBe("updated");
    if (reduction.type !== "updated") throw new Error("expected update");
    expect(reduction.completedCommentary?.text).toBe("thinking\nmore");
    expect(reduction.state.activeCommentary).toBeNull();
    expect(getFinalResponseText(reduction.state)).toBe("answer");
  });

  test("finalizes commentary when its item changes", () => {
    const first = reduceResponseStream(null, delta("first", "commentary", "comment-1"));
    if (first.type !== "updated") throw new Error("expected update");

    const second = reduceResponseStream(first.state, delta("second", "commentary", "comment-2"));
    expect(second.type).toBe("updated");
    if (second.type !== "updated") throw new Error("expected update");
    expect(second.completedCommentary).toEqual({ itemId: "comment-1", text: "first" });
    expect(second.state.activeCommentary).toEqual({ itemId: "comment-2", text: "second" });
  });

  test("uses completed message text as the canonical fallback", () => {
    const partial = reduceResponseStream(null, delta("partial", "final_answer", "final-1"));
    if (partial.type !== "updated") throw new Error("expected update");

    const completed = reduceResponseStream(
      partial.state,
      makeEvent("turn.message.completed", {
        itemId: "final-1",
        phase: "final_answer",
        text: "complete final text",
        turnId: "turn-1",
      }),
    );
    expect(completed.type).toBe("message-completed");
    expect(getFinalResponseText(completed.state)).toBe("complete final text");
  });

  test("preserves multiple final message items in order", () => {
    const first = reduceResponseStream(null, delta("first answer", "final_answer", "final-1"));
    if (first.type !== "updated") throw new Error("expected update");
    const second = reduceResponseStream(first.state, delta("second answer", "final_answer", "final-2"));
    if (second.type !== "updated") throw new Error("expected update");

    expect(getFinalResponseText(second.state)).toBe("first answer\n\nsecond answer");
  });

  test("ignores non-agent and late-turn deltas", () => {
    const initial = createResponseStreamState("turn-1");
    expect(
      reduceResponseStream(
        initial,
        makeEvent("turn.stream.delta", {
          method: "item/commandExecution/outputDelta",
          textDelta: "ignored",
          itemId: "item-1",
          phase: "commentary",
          turnId: "turn-1",
        }),
      ),
    ).toEqual({ type: "none", state: initial });
    expect(reduceResponseStream(initial, delta("late", "final_answer", "final-old", "turn-old"))).toEqual({
      type: "none",
      state: initial,
    });
  });

  test("flushes open commentary and identifies failure at turn end", () => {
    const state = {
      turnId: "turn-1",
      finalMessages: [],
      activeCommentary: { itemId: "comment-1", text: "still useful" },
    };
    const reduction = reduceResponseStream(
      state,
      makeEvent("turn.failed", { turnId: "turn-1", message: "provider failed" }),
    );

    expect(reduction).toEqual({
      type: "finish",
      failed: true,
      state: { ...state, activeCommentary: null },
      completedCommentary: { itemId: "comment-1", text: "still useful" },
    });
  });
});
