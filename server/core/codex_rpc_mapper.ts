import type { ApprovalChoice } from "../../shared/protocol/approvals.js";

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

export function extractTextDelta(method: string, params: unknown): string {
  const lower = method.toLowerCase();
  if (!lower.includes("delta")) {
    return "";
  }

  const record = asRecord(params);
  const msg = asRecord(record.msg);
  const candidates = [
    record.delta,
    record.text,
    record.chunk,
    record.outputDelta,
    record.textDelta,
    msg.delta,
    msg.text,
    msg.chunk,
    msg.outputDelta,
    msg.textDelta,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  return "";
}

export function extractItemId(params: unknown): string | null {
  const record = asRecord(params);
  const msg = asRecord(record.msg);
  return (
    asString(record.itemId) ||
    asString(record.item_id) ||
    asString(msg.itemId) ||
    asString(msg.item_id)
  );
}

export function mapApprovalChoices(method: string): ApprovalChoice[] {
  const normalized = method.toLowerCase();

  if (normalized === "item/commandexecution/requestapproval" || normalized === "item/filechange/requestapproval") {
    return [
      { value: "accept", label: "Allow Once" },
      { value: "acceptForSession", label: "Allow Session" },
      { value: "decline", label: "Deny" },
      { value: "cancel", label: "Cancel" },
    ];
  }

  if (normalized === "execcommandapproval" || normalized === "applypatchapproval") {
    return [
      { value: "approved", label: "Approve Once" },
      { value: "approved_for_session", label: "Approve Session" },
      { value: "denied", label: "Deny" },
      { value: "abort", label: "Abort" },
    ];
  }

  if (normalized === "item/tool/call") {
    return [
      { value: "success", label: "Success" },
      { value: "failure", label: "Failure" },
    ];
  }

  return [
    { value: "approve", label: "Approve" },
    { value: "reject", label: "Reject" },
  ];
}

export function mapApprovalPrompt(method: string, params: unknown): string {
  const record = asRecord(params);
  const reason = asString(record.reason);
  if (reason) return reason;

  if (method === "item/commandExecution/requestApproval") {
    const command = asString(record.command);
    return command ? `Command approval requested: ${command}` : "Command approval requested";
  }

  if (method === "item/fileChange/requestApproval") {
    return "File change approval requested";
  }

  return `${method} requires a decision`;
}
