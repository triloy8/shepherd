import { expect, test } from "bun:test";
import { reasoningTitle } from "../shared/protocol/activity";
import { answerMessages, appendOutput, OUTPUT_TAIL_LIMIT, streamedItem } from "../shared/protocol/item_stream";

const delta = (channel: "plan" | "reasoning" | "output" | "message", text: string, part?: number) => ({ turnId: "turn", itemId: "item", channel, delta: text, phase: null, ...(part === undefined ? {} : { part }) });

test("plan and reasoning deltas build the item they extend", () => {
  const plan = streamedItem(streamedItem(undefined, "item", delta("plan", "1. Read")) ?? undefined, "item", delta("plan", "\n2. Fix"));
  expect(plan).toEqual({ id: "item", type: "plan", text: "1. Read\n2. Fix" });
  let reasoning = streamedItem(undefined, "item", delta("reasoning", "First"));
  reasoning = streamedItem(reasoning!, "item", delta("reasoning", " part"));
  // A named part starts a new summary paragraph; unnamed deltas extend the last.
  reasoning = streamedItem(reasoning!, "item", delta("reasoning", "Second", 1));
  reasoning = streamedItem(reasoning!, "item", delta("reasoning", " part"));
  expect(reasoning).toEqual({ id: "item", type: "reasoning", form: "summary", parts: ["First part", "Second part"] });
  // The delta states the form of reasoning it starts; an item keeps its form.
  const full = streamedItem(undefined, "item", { ...delta("reasoning", "Raw"), form: "full" });
  expect(full).toEqual({ id: "item", type: "reasoning", form: "full", parts: ["Raw"] });
  expect(streamedItem(full!, "item", { ...delta("reasoning", " thought"), form: "summary" })).toEqual({ id: "item", type: "reasoning", form: "full", parts: ["Raw thought"] });
  expect(reasoningTitle("summary")).toBe("Reasoning summary");
  expect(reasoningTitle("full")).toBe("Reasoning");
  expect(streamedItem(undefined, "item", delta("message", "text"))).toBeNull();
  expect(streamedItem(undefined, "item", delta("output", "text"))).toBeNull();
});

test("final messages answer a turn; without phases the last unphased message does", () => {
  expect(answerMessages([{ id: "a", phase: "interim" as const }, { id: "b", phase: "final" as const }, { id: "c" }]).map(m => m.id)).toEqual(["b"]);
  expect(answerMessages([{ id: "a" }, { id: "b", phase: "interim" as const }, { id: "c", phase: null }]).map(m => m.id)).toEqual(["c"]);
  expect(answerMessages([{ id: "a", phase: "interim" as const }])).toEqual([]);
});

test("running output keeps its most recent tail", () => {
  const output = appendOutput("x".repeat(OUTPUT_TAIL_LIMIT), "end");
  expect(output).toHaveLength(OUTPUT_TAIL_LIMIT);
  expect(output.endsWith("end")).toBe(true);
});
