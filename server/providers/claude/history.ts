import type { HistoryContentPart, HistoryItem, HistoryTurn, TurnStatus } from "../../../shared/protocol/requests.js";
import type { TurnActivityEvent, TurnActivityKind } from "../../../shared/protocol/events.js";
import type { UserInput } from "../../../shared/protocol/user_input.js";
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const optionalString = (value: unknown): string | null => typeof value === "string" ? value : null;
const activityKinds: readonly TurnActivityKind[] = ["command", "file_change", "mcp_tool", "dynamic_tool", "web_search", "collaboration", "image", "wait", "other"];

/** Snapshots written before the neutral history contract used other item and status names. */
const legacyTypes: Record<string, HistoryItem["type"]> = { userMessage: "user_message", agentMessage: "assistant_message" };
export const storedTurnStatuses = ["completed", "interrupted", "failed", "in_progress", "inProgress"];

export function historyContent(input: readonly UserInput[]): HistoryContentPart[] {
  return input.map(contentPart);
}

function contentPart(raw: unknown): HistoryContentPart {
  const part = record(raw);
  if (part.type === "text") return { type: "text", text: String(part.text ?? "") };
  if (part.type === "image") return typeof part.url === "string" ? { type: "image", url: part.url } : { type: "image" };
  if ((part.type === "image_file" || part.type === "localImage") && typeof part.path === "string") return { type: "image_file", path: part.path };
  return { type: "attachment", name: optionalString(part.name), path: optionalString(part.path) };
}

function phase(value: unknown) { return value === "commentary" || value === "final_answer" ? value : null; }

/** Decode a stored Claude history record into the application contract. */
export function historyItem(value: unknown, turnId: string): HistoryItem {
  const item = record(value), id = String(item.id ?? "");
  const type = typeof item.type === "string" ? legacyTypes[item.type] ?? item.type : "";
  if (type === "user_message") return { id, type, content: (Array.isArray(item.content) ? item.content : []).map(contentPart) };
  if (type === "assistant_message") {
    const value = phase(item.phase);
    return { id, type, text: String(item.text ?? ""), ...(value ? { phase: value } : {}) };
  }
  if (type === "plan") return { id, type, text: String(item.text ?? "") };
  if (type === "reasoning") return { id, type, summary: Array.isArray(item.summary) ? item.summary.filter((text: unknown): text is string => typeof text === "string") : [] };
  const activity = record(item.activity);
  const decoded: TurnActivityEvent["payload"] | null = Object.keys(activity).length ? {
    itemId: id, turnId,
    kind: activityKinds.includes(activity.kind as TurnActivityKind) ? activity.kind as TurnActivityKind : "other",
    label: String(activity.label ?? "Activity"),
    detail: typeof activity.detail === "string" ? activity.detail : null,
    status: activity.status === "started" || activity.status === "failed" ? activity.status : "completed",
  } : null;
  if (type === "image") {
    const image = record(item.image);
    if (typeof image.path === "string" && (image.kind === "generated" || image.kind === "viewed")) {
      return { id, type, image: { itemId: id, turnId, path: image.path, kind: image.kind, revisedPrompt: typeof image.revisedPrompt === "string" ? image.revisedPrompt : null }, ...(decoded ? { activity: decoded } : {}) };
    }
  }
  if (type === "activity" && decoded) {
    const output = typeof item.output === "string" ? item.output : typeof item.text === "string" ? item.text : undefined;
    return { id, type, activity: decoded, ...(output !== undefined ? { output } : {}) };
  }
  return { id, type: "other" };
}

function turnStatus(value: unknown): TurnStatus {
  return value === "inProgress" || value === "in_progress" ? "in_progress" : value === "interrupted" || value === "failed" ? value : "completed";
}

export function historyTurn(value: unknown): HistoryTurn {
  const turn = record(value), id = String(turn.id ?? "");
  return { id, items: (Array.isArray(turn.items) ? turn.items : []).map((item: unknown) => historyItem(item, id)),
    itemsView: "full",
    status: turnStatus(turn.status),
    error: typeof record(turn.error).message === "string" ? { message: record(turn.error).message as string } : null,
    startedAt: typeof turn.startedAt === "number" ? turn.startedAt : null,
    completedAt: typeof turn.completedAt === "number" ? turn.completedAt : null,
    durationMs: typeof turn.durationMs === "number" ? turn.durationMs : null };
}
