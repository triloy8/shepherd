import type { HistoryContentPart, HistoryItem, HistoryItemsView, HistoryTurn, TurnStatus } from "../../../shared/protocol/requests.js";
import type { MessagePhase } from "../../../shared/protocol/events.js";
import { extractGeneratedImageArtifact, extractViewedImageArtifact, mapTurnActivity } from "./history_presentation.js";
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const optionalString = (value: unknown): string | null => typeof value === "string" ? value : null;

export type NativeItemsView = "notLoaded" | "summary" | "full";
export function codexItemsView(view: HistoryItemsView): NativeItemsView { return view === "none" ? "notLoaded" : view; }
function itemsView(value: unknown): HistoryItemsView { return value === "notLoaded" ? "none" : value === "summary" ? "summary" : "full"; }
function turnStatus(value: unknown): TurnStatus {
  return value === "inProgress" ? "in_progress" : value === "interrupted" || value === "failed" ? value : "completed";
}
/** Codex labels agent messages with OpenAI response phases. */
export function codexPhase(value: unknown): MessagePhase | null { return value === "commentary" ? "interim" : value === "final_answer" ? "final" : null; }

function contentPart(raw: unknown): HistoryContentPart {
  const part = record(raw);
  if (part.type === "text") return { type: "text", text: String(part.text ?? "") };
  if (part.type === "image") return typeof part.url === "string" ? { type: "image", url: part.url } : { type: "image" };
  if (part.type === "localImage" && typeof part.path === "string") return { type: "image_file", path: part.path };
  return { type: "attachment", name: optionalString(part.name), path: optionalString(part.path) };
}

/** Decode a native Codex thread item before it crosses the provider boundary. */
export function historyItem(value: unknown, turnId: string): HistoryItem {
  const item = record(value), id = String(item.id ?? "");
  if (item.type === "userMessage") return { id, type: "user_message", content: (Array.isArray(item.content) ? item.content : []).map(contentPart) };
  if (item.type === "agentMessage") {
    const phase = codexPhase(item.phase);
    return { id, type: "assistant_message", text: String(item.text ?? ""), ...(phase ? { phase } : {}) };
  }
  if (item.type === "plan") return { id, type: "plan", text: String(item.text ?? "") };
  if (item.type === "reasoning") return { id, type: "reasoning", summary: Array.isArray(item.summary) ? item.summary.filter((text: unknown): text is string => typeof text === "string") : [] };
  const generated = extractGeneratedImageArtifact({ turnId, item });
  const viewed = extractViewedImageArtifact({ turnId, item });
  const activity = mapTurnActivity({ turnId, item }, item.status === "inProgress" ? "started" : "completed");
  if (generated) return { id, type: "image", image: { ...generated, kind: "generated" }, ...(activity ? { activity } : {}) };
  if (viewed) return { id, type: "image", image: { ...viewed, kind: "viewed" }, ...(activity ? { activity } : {}) };
  return activity ? { id, type: "activity", activity } : { id, type: "other" };
}

export function historyTurn(value: unknown): HistoryTurn {
  const turn = record(value), id = String(turn.id ?? "");
  return { id, items: (Array.isArray(turn.items) ? turn.items : []).map((item: unknown) => historyItem(item, id)),
    itemsView: itemsView(turn.itemsView),
    status: turnStatus(turn.status),
    error: typeof record(turn.error).message === "string" ? { message: record(turn.error).message as string } : null,
    startedAt: typeof turn.startedAt === "number" ? turn.startedAt : null,
    completedAt: typeof turn.completedAt === "number" ? turn.completedAt : null,
    durationMs: typeof turn.durationMs === "number" ? turn.durationMs : null };
}
