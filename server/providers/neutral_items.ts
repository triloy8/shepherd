import { createHash } from "node:crypto";
import type { BoundedText, ConversationItem, ItemStatus } from "../../shared/protocol/v2/conversation_items.js";
import { assertItemBudget, boundText, V2_BUDGETS } from "../../shared/protocol/v2/budgets.js";
import type { NativeConversationSource } from "./neutral_source.js";

export function publicItemId(threadId: string, nativeId: string): string {
  return createHash("sha256").update(JSON.stringify([threadId, nativeId])).digest("hex");
}
export function itemBase(threadId: string, turnId: string, nativeId: string, status: ItemStatus) {
  return { id: publicItemId(threadId, nativeId), turnId, parentItemId: null, relatedItemIds: [], status,
    startedAt: null, completedAt: null, error: null, recovery: "complete" as const, detailAsset: null,
    unavailableFields: ["startedAt", "completedAt"] as Array<"startedAt" | "completedAt">, omitted: {} };
}
export function assistantItem(source: NativeConversationSource, threadId: string, turnId: string, nativeId: string,
  text: string, phase: "commentary" | "final_answer" | null, status: ItemStatus): ConversationItem {
  const bounded = boundText(text, V2_BUDGETS.messageTextBytes);
  return { ...itemBase(threadId, turnId, nativeId, status), type: "assistant_message", text: bounded, phase,
    detailAsset: bounded.truncated ? source.asset(`${nativeId}:full-text:${createHash("sha256").update(text).digest("hex")}`,
      "text", "text/plain; charset=utf-8", "answer.txt", new TextEncoder().encode(text)) : null };
}
/** Fall back to available display fields instead of leaking a native object or dropping it. */
export function fallbackItem(threadId: string, turnId: string, nativeId: string, name: string, input: string | null,
  output: string | null, status: ItemStatus): ConversationItem {
  return { ...itemBase(threadId, turnId, nativeId, status), type: "tool", source: "provider", server: null,
    name: boundText(name, 256).text, input: input === null ? null : boundText(input, V2_BUDGETS.inputTextBytes),
    output: output === null ? null : boundText(output), assets: [], recovery: "partial" };
}
export function status(value: unknown, terminal?: boolean | ItemStatus): ItemStatus {
  if (value === "failed" || value === "interrupted" || value === "declined" || value === "completed") return value;
  if (value === "inProgress" || value === "in_progress") return "in_progress";
  if (typeof terminal === "string") return terminal;
  return terminal === true ? "completed" : terminal === false ? "in_progress" : "unknown";
}
export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function string(value: unknown): string | null { return typeof value === "string" ? value : null; }
export function phase(value: unknown): "commentary" | "final_answer" | null { return value === "commentary" || value === "final_answer" ? value : null; }
export function validItem(item: ConversationItem): ConversationItem { assertItemBudget(item); return item; }
export function displayText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(block => { const r = record(block); return r.type === "text" || r.type === "input_text" ? string(r.text) : null; }).filter((text): text is string => text !== null).join("\n");
  const object = record(value);
  if (Array.isArray(object.content)) return displayText(object.content);
  return null;
}
export function errorText(value: unknown): BoundedText { return boundText(string(record(value).message) ?? "The provider operation failed."); }
