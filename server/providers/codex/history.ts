import type { HistoryItem, HistoryTurn } from "../../../shared/protocol/requests.js";
import { extractGeneratedImageArtifact, extractViewedImageArtifact, mapTurnActivity } from "./history_presentation.js";
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
/** Decode native persisted items before they cross the provider boundary. */
export function historyItem(value: unknown, turnId: string): HistoryItem {
  const item = record(value), id = String(item.id ?? "");
  if (item.type === "userMessage") return { id, type: "userMessage", content: (Array.isArray(item.content) ? item.content : []).map((raw: unknown) => {
    const part = record(raw);
    if (part.type === "text") return { type: "text", text: String(part.text ?? "") };
    if (part.type === "image") return { type: "image", url: typeof part.url === "string" ? part.url : undefined };
    return { type: String(part.type ?? "attachment"), ...(typeof part.path === "string" ? { path: part.path } : {}), ...(typeof part.name === "string" ? { name: part.name } : {}) };
  }) };
  if (item.type === "agentMessage" || item.type === "plan") return { id, type: item.type, text: String(item.text ?? ""), ...(item.phase === "commentary" || item.phase === "final_answer" ? { phase: item.phase } : {}) };
  if (item.type === "reasoning") return { id, type: "reasoning", summary: Array.isArray(item.summary) ? item.summary.filter((text: unknown) => typeof text === "string") : [] };
  if (item.type === "activity" && item.activity) {
    const activity = record(item.activity);
    const kinds = ["command", "file_change", "mcp_tool", "dynamic_tool", "web_search", "collaboration", "image", "wait", "other"];
    const kind = typeof activity.kind === "string" && kinds.includes(activity.kind) ? activity.kind as NonNullable<HistoryItem["activity"]>["kind"] : "other";
    const status = activity.status === "started" || activity.status === "failed" ? activity.status : "completed";
    return { id, type: "activity", ...(typeof item.text === "string" ? { text: item.text } : {}), activity: { itemId: id, turnId, kind, label: String(activity.label ?? "Activity"), detail: typeof activity.detail === "string" ? activity.detail : null, status } };
  }
  if (item.type === "image") {
    const image = record(item.image);
    if (typeof image.path === "string" && (image.kind === "generated" || image.kind === "viewed")) return { id, type: "image", image: { itemId: id, turnId, path: image.path, kind: image.kind, revisedPrompt: typeof image.revisedPrompt === "string" ? image.revisedPrompt : null } };
  }
  const generated = extractGeneratedImageArtifact({ turnId, item });
  const viewed = extractViewedImageArtifact({ turnId, item });
  const activity = mapTurnActivity({ turnId, item }, item.status === "inProgress" ? "started" : "completed");
  return { id, type: generated || viewed ? "image" : "activity", ...(activity ? { activity } : {}), ...(generated || viewed ? { image: { ...(generated ?? viewed!), kind: generated ? "generated" as const : "viewed" as const } } : {}) };
}
export function historyTurn(value: unknown): HistoryTurn {
  const turn = record(value), id = String(turn.id ?? "");
  return { id, items: (Array.isArray(turn.items) ? turn.items : []).map((item: unknown) => historyItem(item, id)),
    itemsView: turn.itemsView === "summary" || turn.itemsView === "notLoaded" ? turn.itemsView : "full",
    status: turn.status === "interrupted" || turn.status === "failed" || turn.status === "inProgress" ? turn.status : "completed",
    error: typeof record(turn.error).message === "string" ? { message: record(turn.error).message as string } : null,
    startedAt: typeof turn.startedAt === "number" ? turn.startedAt : null,
    completedAt: typeof turn.completedAt === "number" ? turn.completedAt : null,
    durationMs: typeof turn.durationMs === "number" ? turn.durationMs : null };
}
