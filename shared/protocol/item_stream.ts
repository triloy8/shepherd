import type { BridgeEventPayloads, MessagePhase } from "./events.js";
import type { HistoryItem } from "./requests.js";

type ItemDelta = BridgeEventPayloads["item.delta"];
export type StreamedItem = Extract<HistoryItem, { type: "plan" | "reasoning" }>;

/** The plan or reasoning item a delta extends, as it stands so far. Each surface shows streamed
 * plans and reasoning with this one rule, and replaces the result with the canonical item when it
 * completes. Message text and activity output are not items of their own, so they return null. */
export function streamedItem(previous: HistoryItem | undefined, itemId: string, delta: ItemDelta): StreamedItem | null {
  if (delta.channel === "plan") return { id: itemId, type: "plan", text: `${previous?.type === "plan" ? previous.text : ""}${delta.delta}` };
  if (delta.channel !== "reasoning") return null;
  const summary = previous?.type === "reasoning" ? [...previous.summary] : [];
  // A delta names its summary part when the provider has several; otherwise it extends the last.
  const part = delta.part ?? Math.max(0, summary.length - 1);
  while (summary.length <= part) summary.push("");
  summary[part] += delta.delta;
  return { id: itemId, type: "reasoning", summary };
}

/** Which of a turn's assistant messages answer it: those marked final, or without phase
 * metadata, the last unphased message. Interim messages never answer. */
export function answerMessages<T extends { phase?: MessagePhase | null }>(messages: readonly T[]): T[] {
  const finals = messages.filter(message => message.phase === "final");
  if (finals.length) return finals;
  const unphased = messages.filter(message => !message.phase);
  return unphased.slice(-1);
}

/** The most recent output of a running activity, as surfaces show it while it runs. */
export const OUTPUT_TAIL_LIMIT = 16_384;
export function appendOutput(previous: string | undefined, delta: string): string {
  const output = `${previous ?? ""}${delta}`;
  return output.length > OUTPUT_TAIL_LIMIT ? output.slice(-OUTPUT_TAIL_LIMIT) : output;
}
