export { codexApprovalActivity, extractGeneratedImageArtifact, extractViewedImageArtifact } from "./history_presentation.js";
import type { ItemDeltaChannel } from "../../../shared/protocol/events.js";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function extractThreadId(result: unknown): string | null {
  const record = asRecord(result);
  return (
    asString(record.threadId) ||
    asString(record.thread_id) ||
    asString(record.id) ||
    asString(asRecord(record.thread).id) ||
    asString(asRecord(record.thread).threadId)
  );
}

export function extractTurnId(result: unknown): string | null {
  const record = asRecord(result);
  return (
    asString(record.turnId) ||
    asString(record.turn_id) ||
    asString(record.id) ||
    asString(asRecord(record.turn).id) ||
    asString(asRecord(record.turn).turnId)
  );
}

/** Which part of an item a native delta extends. Other native deltas, such as raw reasoning
 * text, stay private. */
export function deltaChannel(method: string): ItemDeltaChannel | null {
  switch (method) {
    case "item/agentMessage/delta": return "message";
    case "item/plan/delta": return "plan";
    case "item/reasoning/summaryTextDelta": return "reasoning";
    case "item/commandExecution/outputDelta": case "item/fileChange/outputDelta": return "output";
    default: return null;
  }
}

export function extractTextDelta(params: unknown): string {
  const record = asRecord(params);
  const msg = asRecord(record.msg);
  const candidates = [record.delta, record.text, record.chunk, record.outputDelta, record.textDelta, msg.delta, msg.text, msg.chunk, msg.outputDelta, msg.textDelta];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return "";
}

export function extractItemId(params: unknown): string | null {
  const record = asRecord(params);
  const item = asRecord(record.item);
  const msg = asRecord(record.msg);
  return (
    asString(record.itemId) ||
    asString(record.item_id) ||
    asString(item.id) ||
    asString(msg.itemId) ||
    asString(msg.item_id)
  );
}

export function mapApprovalChoices(method: string): Array<{ value: string; label: string; intent: "allow" | "deny" | "cancel" }> {
  const normalized = method.toLowerCase();

  if (normalized === "item/commandexecution/requestapproval" || normalized === "item/filechange/requestapproval") {
    return [
      { value: "accept", label: "Allow Once", intent: "allow" },
      { value: "acceptForSession", label: "Allow Session", intent: "allow" },
      { value: "decline", label: "Deny", intent: "deny" },
      { value: "cancel", label: "Cancel", intent: "cancel" },
    ];
  }

  if (normalized === "execcommandapproval" || normalized === "applypatchapproval") {
    return [
      { value: "approved", label: "Approve Once", intent: "allow" },
      { value: "approved_for_session", label: "Approve Session", intent: "allow" },
      { value: "denied", label: "Deny", intent: "deny" },
      { value: "abort", label: "Abort", intent: "cancel" },
    ];
  }

  return [];
}
