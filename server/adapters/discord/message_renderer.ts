import type { ApprovalRequestPayload } from "../../../shared/protocol/approvals.js";
import type { BridgeEvent, TurnActivityEvent, TurnActivityKind } from "../../../shared/protocol/events.js";

function formatStatusBlock(title: string, lines: string[]): string {
  const body = lines.map((line) => line.trim()).filter(Boolean);
  if (body.length === 0) return title;
  return [title, "", ...body].join("\n");
}

export function formatEventLine(event: BridgeEvent): string | null {
  if (event.type === "turn.notification") {
    const payload = event.payload as { method?: string };
    const method = payload?.method?.toLowerCase();
    if (!method) return null;
    if (method.includes("error") || method.includes("failed")) {
      return formatStatusBlock("Event Error", [`Event: ${payload.method}`]);
    }
    return null;
  }

  if (event.type === "session.error") {
    const payload = event.payload as { message?: string };
    return formatStatusBlock("Session Error", [payload.message ?? "Unknown error."]);
  }
  if (event.type === "session.limit.context") {
    return formatStatusBlock("Context Limit Reached", [
      "Try `!compact` or start a new thread.",
    ]);
  }

  if (event.type === "thread.name.updated") {
    const payload = event.payload as { threadName?: string | null };
    return formatStatusBlock("Thread Updated", [`Name: ${payload.threadName ?? "untitled"}`]);
  }
  if (event.type === "thread.archived") return "Thread archived.";
  if (event.type === "thread.unarchived") return "Thread unarchived.";

  if (event.type === "turn.failed") {
    const payload = event.payload as { message?: string };
    return formatStatusBlock("Turn Failed", [payload.message ?? "The turn failed before completion."]);
  }
  if (event.type === "approval.failed") {
    const payload = event.payload as { message?: string };
    return formatStatusBlock("Approval Failed", [payload.message ?? "Unknown error."]);
  }

  return null;
}

const ACTIVITY_ICON: Record<TurnActivityKind, string> = {
  command: "🔧",
  file_change: "📝",
  mcp_tool: "🔌",
  dynamic_tool: "🛠️",
  web_search: "🔎",
  collaboration: "🤝",
  image: "🖼️",
  wait: "⏳",
  other: "•",
};

function redactActivityDetail(value: string): string {
  return value
    .replace(/\b(Bearer)\s+\S+/gi, "$1 [REDACTED]")
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "[REDACTED]")
    .replace(/\b(?:gh[opusr]_|github_pat_)[A-Za-z0-9_]{10,}\b/gi, "[REDACTED]")
    .replace(
      /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*)=([^\s]+)/g,
      "$1=[REDACTED]",
    )
    .replace(/(--?(?:api[-_]?key|token|password|secret)\b(?:=|\s+))([^\s]+)/gi, "$1[REDACTED]")
    .replace(/(["'](?:api[-_]?key|token|password|secret)["']\s*:\s*["'])([^"']+)(["'])/gi, "$1[REDACTED]$3");
}

function truncateActivityDetail(value: string, maxLength = 160): string {
  const collapsed = redactActivityDetail(value).replace(/\s+/g, " ").trim();
  const points = Array.from(collapsed);
  if (points.length <= maxLength) return collapsed;
  return `${points.slice(0, maxLength - 1).join("")}…`;
}

export function formatActivityLine(activity: TurnActivityEvent["payload"]): string {
  const icon = activity.status === "failed" ? "⚠️" : ACTIVITY_ICON[activity.kind];
  const detail = activity.detail ? truncateActivityDetail(activity.detail) : "";
  const statusSuffix = activity.status === "failed" ? " failed" : "";
  return `${icon} ${activity.label}${statusSuffix}${detail ? `: ${detail}` : ""}`;
}

export function formatApprovalText(approval: ApprovalRequestPayload): string {
  const lines: string[] = [];
  lines.push("Approval Required");
  lines.push("");
  lines.push(`Action: ${approval.method}`);
  lines.push("");
  lines.push(approval.prompt.trim());

  if (approval.choices.length > 0) {
    lines.push("");
    lines.push(`Options: ${approval.choices.map((choice) => choice.label).join(" / ")}`);
  }

  return lines.join("\n");
}

export function formatApprovalDecisionLabel(decision: string): string {
  const normalized = decision.trim().toLowerCase();
  if (!normalized) return "Submitted";

  if (normalized.includes("approve") || normalized.includes("accept")) {
    return "Approved";
  }
  if (normalized.includes("reject") || normalized.includes("deny") || normalized.includes("decline")) {
    return "Declined";
  }

  return decision;
}

export function formatApprovalDecisionReply(decision: string): string {
  return `Approval decision recorded: ${formatApprovalDecisionLabel(decision)}`;
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
