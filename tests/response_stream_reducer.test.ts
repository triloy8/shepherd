import { describe, expect, test } from "bun:test";

import {
  createResponseStreamState,
  getFinalResponseText,
  reduceResponseStream,
} from "../server/core/response_stream_reducer.js";
import type { BridgeEvent } from "../shared/protocol/events.js";

function makeEvent<K extends BridgeEvent["type"]>(type: K, payload: import("../shared/protocol/events.js").BridgeEventPayloads[K]): import("../shared/protocol/events.js").BridgeEventOf<K> {
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
  phase: "interim" | "final",
  itemId: string,
  turnId = "turn-1",
): BridgeEvent {
  return makeEvent("turn.stream.delta", {
    kind: "assistant_text",
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
    let reduction = reduceResponseStream(null, delta("thinking\nmore", "interim", "comment-1"));
    expect(reduction.type).toBe("updated");
    if (reduction.type !== "updated") throw new Error("expected update");
    expect(reduction.state.activeCommentary?.text).toBe("thinking\nmore");
    expect(getFinalResponseText(reduction.state)).toBe("");

    reduction = reduceResponseStream(reduction.state, delta("answer", "final", "final-1"));
    expect(reduction.type).toBe("updated");
    if (reduction.type !== "updated") throw new Error("expected update");
    expect(reduction.completedCommentary?.text).toBe("thinking\nmore");
    expect(reduction.state.activeCommentary).toBeNull();
    expect(getFinalResponseText(reduction.state)).toBe("answer");
  });

  test("finalizes commentary when its item changes", () => {
    const first = reduceResponseStream(null, delta("first", "interim", "comment-1"));
    if (first.type !== "updated") throw new Error("expected update");

    const second = reduceResponseStream(first.state, delta("second", "interim", "comment-2"));
    expect(second.type).toBe("updated");
    if (second.type !== "updated") throw new Error("expected update");
    expect(second.completedCommentary).toEqual({ itemId: "comment-1", text: "first" });
    expect(second.state.activeCommentary).toEqual({ itemId: "comment-2", text: "second" });
  });

  test("uses completed message text as the canonical fallback", () => {
    const partial = reduceResponseStream(null, delta("partial", "final", "final-1"));
    if (partial.type !== "updated") throw new Error("expected update");

    const completed = reduceResponseStream(
      partial.state,
      makeEvent("turn.message.completed", {
        itemId: "final-1",
        phase: "final",
        text: "complete final text",
        turnId: "turn-1",
      }),
    );
    expect(completed.type).toBe("message-completed");
    expect(getFinalResponseText(completed.state)).toBe("complete final text");
  });

  test("preserves multiple final message items in order", () => {
    const first = reduceResponseStream(null, delta("first answer", "final", "final-1"));
    if (first.type !== "updated") throw new Error("expected update");
    const second = reduceResponseStream(first.state, delta("second answer", "final", "final-2"));
    if (second.type !== "updated") throw new Error("expected update");

    expect(getFinalResponseText(second.state)).toBe("first answer\n\nsecond answer");
  });

  test("ignores non-agent and late-turn deltas", () => {
    const initial = createResponseStreamState("turn-1");
    expect(
      reduceResponseStream(
        initial,
        makeEvent("turn.stream.delta", {
          kind: "other",
          textDelta: "ignored",
          itemId: "item-1",
          phase: "interim",
          turnId: "turn-1",
        }),
      ),
    ).toEqual({ type: "none", state: initial });
    expect(reduceResponseStream(initial, delta("late", "final", "final-old", "turn-old"))).toEqual({
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

test("unphased messages use canonical text and the last answer unless an explicit final is reported", () => {
  let state = createResponseStreamState("turn-1");
  const unknown = (itemId: string, textDelta: string) => makeEvent("turn.stream.delta", { kind: "assistant_text", phase: null, itemId, textDelta, turnId: "turn-1" });
  for (const event of [unknown("work", "Thinking"), unknown("answer", "Partial"),
    makeEvent("turn.message.completed", { itemId: "answer", phase: null, text: "Canonical answer", turnId: "turn-1" })]) state = reduceResponseStream(state, event).state!;
  expect(getFinalResponseText(state)).toBe("Canonical answer");
  state = reduceResponseStream(state, delta("Explicit answer", "final", "explicit")).state!;
  state = reduceResponseStream(state, unknown("trailing", "Unclassified activity")).state!;
  expect(getFinalResponseText(state)).toBe("Explicit answer");
  const finish = reduceResponseStream(state, makeEvent("turn.completed", { turnId: "turn-1" }));
  expect(getFinalResponseText(finish.state)).toBe("Explicit answer");
  expect(reduceResponseStream(state, unknown("answer", "late")).type).toBe("updated");
  expect(reduceResponseStream(state, makeEvent("turn.message.completed", { itemId: "late", phase: null, text: "Wrong turn", turnId: "other" })).type).toBe("none");
});

test("completed-only unphased providers do not need a delta or a turn-start event", () => {
  const reduction = reduceResponseStream(null, makeEvent("turn.message.completed", { itemId: "answer", phase: null, text: "Hello", turnId: "turn-1" }));
  expect(getFinalResponseText(reduction.state)).toBe("Hello");
  const cleared = reduceResponseStream(reduction.state, makeEvent("turn.started", { turnId: "turn-2" }));
  expect(getFinalResponseText(cleared.state)).toBe("");
});

test("known phases survive missing metadata and late classification preserves earlier deltas", () => {
  let state = reduceResponseStream(null, makeEvent("turn.stream.delta", { kind: "assistant_text", phase: null, itemId: "work", textDelta: "Unclassified ", turnId: "turn-1" })).state!;
  state = reduceResponseStream(state, delta("progress", "interim", "work")).state!;
  const progress = reduceResponseStream(state, makeEvent("turn.message.completed", { itemId: "work", phase: null, text: "Canonical progress", turnId: "turn-1" }));
  expect(progress.type).toBe("message-completed");
  if (progress.type !== "message-completed") throw new Error("Expected completion");
  expect(progress.phase).toBe("interim"); expect(progress.completedCommentary?.text).toBe("Canonical progress");
  expect(getFinalResponseText(progress.state)).toBe("");
  state = reduceResponseStream(progress.state, makeEvent("turn.stream.delta", { kind: "assistant_text", phase: null, itemId: "answer", textDelta: "First ", turnId: "turn-1" })).state!;
  state = reduceResponseStream(state, delta("second", "final", "answer")).state!;
  state = reduceResponseStream(state, makeEvent("turn.stream.delta", { kind: "assistant_text", phase: null, itemId: "answer", textDelta: " third", turnId: "turn-1" })).state!;
  expect(getFinalResponseText(state)).toBe("First second third");
  state = reduceResponseStream(state, makeEvent("turn.message.completed", { itemId: "answer", phase: null, text: "Canonical final", turnId: "turn-1" })).state!;
  expect(getFinalResponseText(state)).toBe("Canonical final");
});

for (const reportedPhase of ["final", "interim", null] as const) test(`anonymous deltas reconcile canonical completion with phase ${reportedPhase}`, () => {
  let state = createResponseStreamState("turn-1");
  for (const textDelta of ["Hello", " world"]) state = reduceResponseStream(state, makeEvent("turn.stream.delta", { kind: "assistant_text", itemId: null, turnId: null, phase: reportedPhase, textDelta })).state!;
  const completed = reduceResponseStream(state, makeEvent("turn.message.completed", { itemId: "canonical", turnId: null, phase: null, text: "Canonical answer" }));
  expect(getFinalResponseText(completed.state)).toBe(reportedPhase === "interim" ? "" : "Canonical answer");
  if (completed.type !== "message-completed") throw new Error("Expected completion");
  expect(completed.completedCommentary?.text).toBe(reportedPhase === "interim" ? "Canonical answer" : undefined);
});

test("anonymous and identified stream chunks form one final message and separate subsequent messages", () => {
  let state = createResponseStreamState("turn-1");
  for (const [index, itemId] of [null, "canonical", null, "canonical"].entries()) state = reduceResponseStream(state, makeEvent("turn.stream.delta", { kind: "assistant_text", itemId, turnId: "turn-1", phase: "final", textDelta: String(index) })).state!;
  state = reduceResponseStream(state, makeEvent("turn.message.completed", { itemId: "canonical", turnId: "turn-1", phase: null, text: "First answer" })).state!;
  state = reduceResponseStream(state, makeEvent("turn.stream.delta", { kind: "assistant_text", itemId: null, turnId: "turn-1", phase: "final", textDelta: "Second partial" })).state!;
  state = reduceResponseStream(state, makeEvent("turn.message.completed", { itemId: "second", turnId: "turn-1", phase: null, text: "Second answer" })).state!;
  expect(getFinalResponseText(state)).toBe("First answer\n\nSecond answer");
});

test("completed interim phases survive canonical updates and reset only with a new turn", () => {
  let state = reduceResponseStream(null, delta("Working", "interim", "item")).state!;
  state = reduceResponseStream(state, makeEvent("turn.message.completed", { itemId: "item", turnId: "turn-1", phase: "interim", text: "Working" })).state!;
  state = reduceResponseStream(state, makeEvent("turn.message.completed", { itemId: "item", turnId: "turn-1", phase: null, text: "Updated progress" })).state!;
  expect(getFinalResponseText(state)).toBe("");
  state = reduceResponseStream(state, makeEvent("turn.started", { turnId: "turn-2" })).state!;
  state = reduceResponseStream(state, makeEvent("turn.message.completed", { itemId: "item", turnId: "turn-2", phase: null, text: "New answer" })).state!;
  expect(getFinalResponseText(state)).toBe("New answer");
});
