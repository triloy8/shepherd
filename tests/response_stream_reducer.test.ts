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
  return makeEvent("item.delta", { turnId: turnId, itemId: itemId, channel: "message", delta: textDelta, phase: phase });
}

describe("ResponseStreamReducer", () => {
  test("resets all output state for a new turn", () => {
    const reduction = reduceResponseStream(
      {
        turnId: "turn-old",
        finalMessages: [{ itemId: "final-old", text: "existing" }],
        activeInterim: { itemId: "comment-old", text: "thinking" },
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
    expect(reduction.state.activeInterim?.text).toBe("thinking\nmore");
    expect(getFinalResponseText(reduction.state)).toBe("");

    reduction = reduceResponseStream(reduction.state, delta("answer", "final", "final-1"));
    expect(reduction.type).toBe("updated");
    if (reduction.type !== "updated") throw new Error("expected update");
    expect(reduction.completedInterim?.text).toBe("thinking\nmore");
    expect(reduction.state.activeInterim).toBeNull();
    expect(getFinalResponseText(reduction.state)).toBe("answer");
  });

  test("finalizes commentary when its item changes", () => {
    const first = reduceResponseStream(null, delta("first", "interim", "comment-1"));
    if (first.type !== "updated") throw new Error("expected update");

    const second = reduceResponseStream(first.state, delta("second", "interim", "comment-2"));
    expect(second.type).toBe("updated");
    if (second.type !== "updated") throw new Error("expected update");
    expect(second.completedInterim).toEqual({ itemId: "comment-1", text: "first" });
    expect(second.state.activeInterim).toEqual({ itemId: "comment-2", text: "second" });
  });

  test("uses completed message text as the canonical fallback", () => {
    const partial = reduceResponseStream(null, delta("partial", "final", "final-1"));
    if (partial.type !== "updated") throw new Error("expected update");

    const completed = reduceResponseStream(
      partial.state,
      makeEvent("item.completed", { turnId: "turn-1", item: { id: "final-1", type: "assistant_message", text: "complete final text", phase: "final" } }),
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
        makeEvent("item.delta", { turnId: "turn-1", itemId: "item-1", channel: "reasoning", delta: "ignored", phase: "interim" }),
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
      activeInterim: { itemId: "comment-1", text: "still useful" },
    };
    const reduction = reduceResponseStream(
      state,
      makeEvent("turn.failed", { turnId: "turn-1", message: "provider failed" }),
    );

    expect(reduction).toEqual({
      type: "finish",
      failed: true,
      state: { ...state, activeInterim: null },
      completedInterim: { itemId: "comment-1", text: "still useful" },
    });
  });
});

test("unphased messages use canonical text and the last answer unless an explicit final is reported", () => {
  let state = createResponseStreamState("turn-1");
  const unknown = (itemId: string, textDelta: string) => makeEvent("item.delta", { turnId: "turn-1", itemId: itemId, channel: "message", delta: textDelta, phase: null });
  for (const event of [unknown("work", "Thinking"), unknown("answer", "Partial"),
    makeEvent("item.completed", { turnId: "turn-1", item: { id: "answer", type: "assistant_message", text: "Canonical answer" } })]) state = reduceResponseStream(state, event).state!;
  expect(getFinalResponseText(state)).toBe("Canonical answer");
  state = reduceResponseStream(state, delta("Explicit answer", "final", "explicit")).state!;
  state = reduceResponseStream(state, unknown("trailing", "Unclassified activity")).state!;
  expect(getFinalResponseText(state)).toBe("Explicit answer");
  const finish = reduceResponseStream(state, makeEvent("turn.completed", { turnId: "turn-1" }));
  expect(getFinalResponseText(finish.state)).toBe("Explicit answer");
  expect(reduceResponseStream(state, unknown("answer", "late")).type).toBe("updated");
  expect(reduceResponseStream(state, makeEvent("item.completed", { turnId: "other", item: { id: "late", type: "assistant_message", text: "Wrong turn" } })).type).toBe("none");
});

test("completed-only unphased providers do not need a delta or a turn-start event", () => {
  const reduction = reduceResponseStream(null, makeEvent("item.completed", { turnId: "turn-1", item: { id: "answer", type: "assistant_message", text: "Hello" } }));
  expect(getFinalResponseText(reduction.state)).toBe("Hello");
  const cleared = reduceResponseStream(reduction.state, makeEvent("turn.started", { turnId: "turn-2" }));
  expect(getFinalResponseText(cleared.state)).toBe("");
});

test("a subagent's text never becomes the conversation's answer", () => {
  const state = reduceResponseStream(null, makeEvent("item.completed", { turnId: "turn-1", item: { id: "answer", type: "assistant_message", text: "Done", phase: "final" } })).state!;
  const subagent = reduceResponseStream(state, makeEvent("item.completed", { turnId: "turn-1", item: { id: "sub", type: "assistant_message", text: "Subagent finding", phase: "final", parentItemId: "agent-call" } }));
  expect(subagent.type).toBe("none");
  expect(getFinalResponseText(state)).toBe("Done");
});

test("known phases survive missing metadata and late classification preserves earlier deltas", () => {
  let state = reduceResponseStream(null, makeEvent("item.delta", { turnId: "turn-1", itemId: "work", channel: "message", delta: "Unclassified ", phase: null })).state!;
  state = reduceResponseStream(state, delta("progress", "interim", "work")).state!;
  const progress = reduceResponseStream(state, makeEvent("item.completed", { turnId: "turn-1", item: { id: "work", type: "assistant_message", text: "Canonical progress" } }));
  expect(progress.type).toBe("message-completed");
  if (progress.type !== "message-completed") throw new Error("Expected completion");
  expect(progress.phase).toBe("interim"); expect(progress.completedInterim?.text).toBe("Canonical progress");
  expect(getFinalResponseText(progress.state)).toBe("");
  state = reduceResponseStream(progress.state, makeEvent("item.delta", { turnId: "turn-1", itemId: "answer", channel: "message", delta: "First ", phase: null })).state!;
  state = reduceResponseStream(state, delta("second", "final", "answer")).state!;
  state = reduceResponseStream(state, makeEvent("item.delta", { turnId: "turn-1", itemId: "answer", channel: "message", delta: " third", phase: null })).state!;
  expect(getFinalResponseText(state)).toBe("First second third");
  state = reduceResponseStream(state, makeEvent("item.completed", { turnId: "turn-1", item: { id: "answer", type: "assistant_message", text: "Canonical final" } })).state!;
  expect(getFinalResponseText(state)).toBe("Canonical final");
});

for (const reportedPhase of ["final", "interim", null] as const) test(`anonymous deltas reconcile canonical completion with phase ${reportedPhase}`, () => {
  let state = createResponseStreamState("turn-1");
  for (const textDelta of ["Hello", " world"]) state = reduceResponseStream(state, makeEvent("item.delta", { turnId: null, itemId: null, channel: "message", delta: textDelta, phase: reportedPhase })).state!;
  const completed = reduceResponseStream(state, makeEvent("item.completed", { turnId: null, item: { id: "canonical", type: "assistant_message", text: "Canonical answer" } }));
  expect(getFinalResponseText(completed.state)).toBe(reportedPhase === "interim" ? "" : "Canonical answer");
  if (completed.type !== "message-completed") throw new Error("Expected completion");
  expect(completed.completedInterim?.text).toBe(reportedPhase === "interim" ? "Canonical answer" : undefined);
});

test("anonymous and identified stream chunks form one final message and separate subsequent messages", () => {
  let state = createResponseStreamState("turn-1");
  for (const [index, itemId] of [null, "canonical", null, "canonical"].entries()) state = reduceResponseStream(state, makeEvent("item.delta", { turnId: "turn-1", itemId: itemId, channel: "message", delta: String(index), phase: "final" })).state!;
  state = reduceResponseStream(state, makeEvent("item.completed", { turnId: "turn-1", item: { id: "canonical", type: "assistant_message", text: "First answer" } })).state!;
  state = reduceResponseStream(state, makeEvent("item.delta", { turnId: "turn-1", itemId: null, channel: "message", delta: "Second partial", phase: "final" })).state!;
  state = reduceResponseStream(state, makeEvent("item.completed", { turnId: "turn-1", item: { id: "second", type: "assistant_message", text: "Second answer" } })).state!;
  expect(getFinalResponseText(state)).toBe("First answer\n\nSecond answer");
});

test("completed interim phases survive canonical updates and reset only with a new turn", () => {
  let state = reduceResponseStream(null, delta("Working", "interim", "item")).state!;
  state = reduceResponseStream(state, makeEvent("item.completed", { turnId: "turn-1", item: { id: "item", type: "assistant_message", text: "Working", phase: "interim" } })).state!;
  state = reduceResponseStream(state, makeEvent("item.completed", { turnId: "turn-1", item: { id: "item", type: "assistant_message", text: "Updated progress" } })).state!;
  expect(getFinalResponseText(state)).toBe("");
  state = reduceResponseStream(state, makeEvent("turn.started", { turnId: "turn-2" })).state!;
  state = reduceResponseStream(state, makeEvent("item.completed", { turnId: "turn-2", item: { id: "item", type: "assistant_message", text: "New answer" } })).state!;
  expect(getFinalResponseText(state)).toBe("New answer");
});

for (const phase of ["final", "interim", null] as const) test(`empty canonical ${phase} completion clears provisional text`, () => {
  const partial = reduceResponseStream(null, makeEvent("item.delta", { turnId: "turn", itemId: null, channel: "message", delta: "Discard this", phase: phase }));
  const completed = reduceResponseStream(partial.state, makeEvent("item.completed", { turnId: "turn", item: { id: "a", type: "assistant_message", text: "", ...(phase ? { phase: phase } : {}) } }));
  expect(getFinalResponseText(completed.state)).toBe("");
  expect(completed.type === "message-completed" && completed.completedInterim).toBeNull();
});

for (const phase of ["interim", null] as const) test(`identifying anonymous interim text with phase ${phase} does not finish its prefix`, () => {
  const first = reduceResponseStream(null, makeEvent("item.delta", { turnId: "t", itemId: null, channel: "message", delta: "I am ", phase: "interim" }));
  const identified = reduceResponseStream(first.state, makeEvent("item.delta", { turnId: "t", itemId: "a", channel: "message", delta: "working", phase: phase }));
  expect(identified.type).toBe("updated");
  expect(identified.type === "updated" && identified.completedInterim).toBeNull();
  expect(identified.state?.activeInterim).toEqual({ itemId: "a", text: "I am working" });
  const completed = reduceResponseStream(identified.state, makeEvent("item.completed", { turnId: "t", item: { id: "a", type: "assistant_message", text: "I am working" } }));
  expect(completed.type === "message-completed" && completed.completedInterim?.text).toBe("I am working");
});
