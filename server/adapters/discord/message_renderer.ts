import { randomUUID } from "node:crypto";
import type { ApprovalChoice, ApprovalRequestPayload } from "../../../shared/protocol/approvals.js";
import type { BridgeEvent, TurnActivityEvent } from "../../../shared/protocol/events.js";
import { describeActivity, describePermission, type Activity } from "../../../shared/protocol/activity.js";

function formatStatusBlock(title: string, lines: string[]): string {
  const body = lines.map((line) => line.trim()).filter(Boolean);
  if (body.length === 0) return title;
  return [title, "", ...body].join("\n");
}

export function formatEventLine(event: BridgeEvent): string | null {

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

function activityIcon(activity: Activity): string {
  switch (activity.kind) {
    case "command": return "🔧";
    case "file_change": return "📝";
    case "tool": return activity.source === "mcp" ? "🔌" : activity.source === "application" ? "🛠️" : "•";
    case "web": return "🔎";
    case "delegation": return "🤝";
    case "image": return "🖼️";
    case "wait": return "⏳";
    case "other": return "•";
  }
}

function redactActivityDetail(value: string): string {
  return value
    .replace(
      /http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/signals\/[A-Za-z0-9_-]{20,128}/gi,
      "[REDACTED_SIGNAL_URL]",
    )
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

export function formatActivityLine(payload: Pick<TurnActivityEvent["payload"], "activity" | "status">): string {
  const icon = payload.status === "failed" ? "⚠️" : activityIcon(payload.activity);
  const { title, detail } = describeActivity(payload.activity);
  const shown = detail ? truncateActivityDetail(detail) : "";
  const statusSuffix = payload.status === "failed" ? " failed" : "";
  return `${icon} ${title}${statusSuffix}${shown ? `: ${shown}` : ""}`;
}

/** What an approval asks: the permission written from its activity, or the questions. */
export function approvalRequestLines(approval: ApprovalRequestPayload): string[] {
  if (approval.kind === "question") return approval.userInput.questions.map((question) => question.question.trim());
  const { title, detail } = describePermission(approval.activity);
  return [title, ...(approval.reason?.trim() ? [approval.reason.trim()] : []), ...(detail ? [redactActivityDetail(detail)] : [])];
}

export function formatApprovalText(approval: ApprovalRequestPayload): string {
  const lines: string[] = [];
  lines.push("Approval Required");
  lines.push("");
  lines.push(`Action: ${approval.kind}`);
  lines.push("");
  lines.push(...approvalRequestLines(approval));

  if (approval.choices.length > 0) {
    lines.push("");
    lines.push(`Options: ${approval.choices.map((choice) => choice.label).join(" / ")}`);
  }

  return lines.join("\n");
}

const intentLabels: Record<ApprovalChoice["intent"], string> = { allow: "Approved", deny: "Declined", answer: "Answered", cancel: "Cancelled" };

/** The outcome comes from the choice's declared intent; the provider's label adds its wording. */
export function formatApprovalDecisionLabel(choice: Pick<ApprovalChoice, "label" | "intent"> | undefined): string {
  if (!choice) return "Submitted";
  const outcome = intentLabels[choice.intent] ?? "Submitted";
  const label = choice.label.trim();
  return label && label.toLowerCase() !== outcome.toLowerCase() ? `${outcome} (${label})` : outcome;
}

export function formatApprovalDecisionReply(choice: Pick<ApprovalChoice, "label" | "intent"> | undefined): string {
  return `Approval decision recorded: ${formatApprovalDecisionLabel(choice)}`;
}

const approvalButtons = new Map<string, { threadId: string; approvalId: string; decision: string; expires: number }>();
export function encodeApprovalButtonId(threadId: string, approvalId: string, decision: string): string {
  const now = Date.now();
  for (const [id, value] of approvalButtons) if (value.expires <= now) approvalButtons.delete(id);
  while (approvalButtons.size >= 4000) approvalButtons.delete(approvalButtons.keys().next().value!);
  const id = `approval|${randomUUID()}`;
  approvalButtons.set(id, { threadId, approvalId, decision, expires: now + 3600000 });
  return id;
}
export function decodeApprovalButtonId(customId: string): { threadId: string; approvalId: string; decision: string } | null {
  const entry = approvalButtons.get(customId);
  if (!entry || entry.expires <= Date.now()) return null;
  return { threadId: entry.threadId, approvalId: entry.approvalId, decision: entry.decision };
}
