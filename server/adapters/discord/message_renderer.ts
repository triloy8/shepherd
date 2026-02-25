import type { ApprovalRequestPayload } from "../../../shared/protocol/approvals.js";
import type { BridgeEvent } from "../../../shared/protocol/events.js";

export function formatEventLine(event: BridgeEvent): string | null {
  if (event.type === "turn.notification") {
    const payload = event.payload as { method?: string };
    const method = payload?.method?.toLowerCase();
    if (!method) return null;
    if (method.includes("error") || method.includes("failed")) {
      return `error event: ${payload.method}`;
    }
    return null;
  }

  if (event.type === "session.error") {
    const payload = event.payload as { message?: string };
    return `session error: ${payload.message ?? "unknown"}`;
  }

  if (event.type === "turn.failed") return "turn failed";
  if (event.type === "approval.failed") {
    const payload = event.payload as { message?: string };
    return `approval failed: ${payload.message ?? "unknown"}`;
  }

  return null;
}

export function formatApprovalText(approval: ApprovalRequestPayload): string {
  const lines: string[] = [];
  lines.push(`approval requested: ${approval.method}`);
  lines.push(approval.prompt);
  return lines.join("\n");
}

export function encodeApprovalButtonId(threadId: string, approvalId: string, decision: string): string {
  return `approval|${threadId}|${approvalId}|${decision}`;
}

export function decodeApprovalButtonId(customId: string):
  | { threadId: string; approvalId: string; decision: string }
  | null {
  const parts = customId.split("|");
  if (parts.length < 4 || parts[0] !== "approval") return null;
  return {
    threadId: parts[1],
    approvalId: parts[2],
    decision: parts.slice(3).join("|"),
  };
}
