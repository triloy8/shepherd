import type { HistoryContentPart, HistoryItem, HistoryTurn, ThreadTokenUsage, TokenUsageBreakdown } from "../../../shared/protocol/requests.js";
import type { TurnActivityEvent } from "../../../shared/protocol/events.js";
import { claudeActivity, claudeActivityFields, type ClaudeActivityFields } from "./activity.js";
import type { UserInput } from "../../../shared/protocol/user_input.js";

/* Claude's saved snapshot format. It belongs to this adapter: snapshots are normalized into
 * these types when read and decoded into the application contract only when presented, so a
 * change to the shared contract never changes what is on disk. */
export type ClaudeStoredContentPart =
  | { type: "text"; text: string }
  | { type: "image"; url?: string }
  | { type: "image_file"; path: string }
  | { type: "audio"; url?: string }
  | { type: "audio_file"; path: string }
  | { type: "skill"; name: string; path: string }
  | { type: "attachment"; name: string | null; path: string | null };
/** A tool call as Claude made it: the tool name and the bounded arguments it is described from. */
export type ClaudeStoredActivity = { tool: string; fields: ClaudeActivityFields; status: "started" | "completed" | "failed" };
export type ClaudeStoredItem =
  | { id: string; type: "user_message"; content: ClaudeStoredContentPart[] }
  | { id: string; type: "assistant_message"; text: string; phase?: "interim" | "final" }
  | { id: string; type: "plan"; text: string }
  | { id: string; type: "reasoning"; summary: string[] }
  | { id: string; type: "activity"; activity: ClaudeStoredActivity }
  | { id: string; type: "image"; image: { path: string; kind: "generated" | "viewed"; prompt: string | null }; activity?: ClaudeStoredActivity }
  | { id: string; type: "other" };
export type ClaudeStoredTurn = {
  id: string; items: ClaudeStoredItem[]; status: "completed" | "interrupted" | "failed" | "in_progress";
  error: { message: string } | null; startedAt: number | null; completedAt: number | null; durationMs: number | null;
};
export type ClaudeStoredUsage = {
  inputTokens: number | null; cacheReadInputTokens: number | null; cacheWriteInputTokens: number | null;
  outputTokens: number | null; reasoningOutputTokens: number | null; totalTokens: number | null;
};
export type ClaudeStoredTokenUsage = { last: ClaudeStoredUsage | null; total: ClaudeStoredUsage | null; contextWindow: number | null };

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const optionalString = (value: unknown): string | null => typeof value === "string" ? value : null;

/** Snapshots written before the neutral history contract used other item and status names. */
const legacyTypes: Record<string, ClaudeStoredItem["type"]> = { userMessage: "user_message", agentMessage: "assistant_message" };
export const storedTurnStatuses = ["completed", "interrupted", "failed", "in_progress", "inProgress"];

export function storedContent(input: readonly UserInput[]): ClaudeStoredContentPart[] {
  return input.map(storedContentPart);
}

function storedContentPart(raw: unknown): ClaudeStoredContentPart {
  const part = record(raw);
  if (part.type === "text") return { type: "text", text: String(part.text ?? "") };
  if (part.type === "image") return typeof part.url === "string" ? { type: "image", url: part.url } : { type: "image" };
  if ((part.type === "image_file" || part.type === "localImage") && typeof part.path === "string") return { type: "image_file", path: part.path };
  if (part.type === "audio") return typeof part.url === "string" ? { type: "audio", url: part.url } : { type: "audio" };
  if (part.type === "audio_file" && typeof part.path === "string") return { type: "audio_file", path: part.path };
  if (part.type === "skill" && typeof part.name === "string" && typeof part.path === "string") return { type: "skill", name: part.name, path: part.path };
  return { type: "attachment", name: optionalString(part.name), path: optionalString(part.path) };
}

function storedPhase(value: unknown): "interim" | "final" | null {
  if (value === "interim" || value === "commentary") return "interim";
  return value === "final" || value === "final_answer" ? "final" : null;
}

/** Snapshots without a native tool name have no activity to present; their items read as `other`. */
function storedActivity(value: unknown): ClaudeStoredActivity | null {
  const activity = record(value);
  if (typeof activity.tool !== "string" || !activity.tool) return null;
  return {
    tool: activity.tool, fields: claudeActivityFields(activity.fields),
    status: activity.status === "started" || activity.status === "failed" ? activity.status : "completed",
  };
}

/** Normalize a saved item, including names and fields from earlier snapshots. */
export function storedItem(value: unknown): ClaudeStoredItem {
  const item = record(value), id = String(item.id ?? "");
  const type = typeof item.type === "string" ? legacyTypes[item.type] ?? item.type : "";
  if (type === "user_message") return { id, type, content: (Array.isArray(item.content) ? item.content : []).map(storedContentPart) };
  if (type === "assistant_message") {
    const phase = storedPhase(item.phase);
    return { id, type, text: String(item.text ?? ""), ...(phase ? { phase } : {}) };
  }
  if (type === "plan") return { id, type, text: String(item.text ?? "") };
  if (type === "reasoning") return { id, type, summary: Array.isArray(item.summary) ? item.summary.filter((text: unknown): text is string => typeof text === "string") : [] };
  const activity = storedActivity(item.activity);
  if (type === "image") {
    const image = record(item.image);
    if (typeof image.path === "string" && (image.kind === "generated" || image.kind === "viewed")) {
      const prompt = typeof image.prompt === "string" ? image.prompt : typeof image.revisedPrompt === "string" ? image.revisedPrompt : null;
      return { id, type, image: { path: image.path, kind: image.kind, prompt }, ...(activity ? { activity } : {}) };
    }
  }
  if (type === "activity" && activity) return { id, type, activity };
  return { id, type: "other" };
}

export function storedTurn(value: unknown): ClaudeStoredTurn {
  const turn = record(value);
  const status = turn.status === "inProgress" || turn.status === "in_progress" ? "in_progress" : turn.status === "interrupted" || turn.status === "failed" ? turn.status : "completed";
  return {
    id: String(turn.id ?? ""), items: (Array.isArray(turn.items) ? turn.items : []).map(storedItem), status,
    error: typeof record(turn.error).message === "string" ? { message: record(turn.error).message as string } : null,
    startedAt: typeof turn.startedAt === "number" ? turn.startedAt : null,
    completedAt: typeof turn.completedAt === "number" ? turn.completedAt : null,
    durationMs: typeof turn.durationMs === "number" ? turn.durationMs : null,
  };
}

const count = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
function storedUsageBreakdown(value: unknown, legacyReasoning: boolean): ClaudeStoredUsage | null {
  const usage = record(value);
  const inputTokens = count(usage.inputTokens), outputTokens = count(usage.outputTokens);
  if (!["inputTokens", "outputTokens", "totalTokens", "cacheReadInputTokens", "cacheWriteInputTokens", "cachedInputTokens", "reasoningOutputTokens"].some(key => count(usage[key]) !== null)) return null;
  return {
    inputTokens, outputTokens, totalTokens: count(usage.totalTokens) ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null),
    cacheReadInputTokens: count(usage.cacheReadInputTokens) ?? count(usage.cachedInputTokens),
    cacheWriteInputTokens: count(usage.cacheWriteInputTokens),
    reasoningOutputTokens: legacyReasoning ? null : count(usage.reasoningOutputTokens),
  };
}

/** Normalize saved usage. Earlier snapshots recorded an unknown per-request reasoning count as zero. */
export function storedTokenUsage(value: unknown): ClaudeStoredTokenUsage | undefined {
  const usage = record(value);
  const legacy = Object.hasOwn(usage, "modelContextWindow");
  const last = storedUsageBreakdown(usage.last, legacy), total = storedUsageBreakdown(usage.total, false);
  if (!last && !total) return undefined;
  return { last, total, contextWindow: count(legacy ? usage.modelContextWindow : usage.contextWindow) };
}

/* Presentation: saved records to the application contract. */

export function activityPayload(activity: ClaudeStoredActivity, itemId: string, turnId: string): TurnActivityEvent["payload"] {
  return { itemId, turnId, status: activity.status, activity: claudeActivity(activity.tool, activity.fields) };
}

function contentPart(part: ClaudeStoredContentPart): HistoryContentPart {
  switch (part.type) {
    case "text": return { type: "text", text: part.text };
    case "image": return part.url === undefined ? { type: "image" } : { type: "image", url: part.url };
    case "image_file": return { type: "image_file", path: part.path };
    case "audio": return part.url === undefined ? { type: "audio" } : { type: "audio", url: part.url };
    case "audio_file": return { type: "audio_file", path: part.path };
    case "skill": return { type: "skill", name: part.name, path: part.path };
    case "attachment": return { type: "attachment", name: part.name, path: part.path };
  }
}

export function historyItem(item: ClaudeStoredItem, turnId: string): HistoryItem {
  switch (item.type) {
    case "user_message": return { id: item.id, type: item.type, content: item.content.map(contentPart) };
    case "assistant_message": return { id: item.id, type: item.type, text: item.text, ...(item.phase ? { phase: item.phase } : {}) };
    case "plan": return { id: item.id, type: item.type, text: item.text };
    case "reasoning": return { id: item.id, type: item.type, summary: [...item.summary] };
    case "activity": return { id: item.id, type: item.type, activity: activityPayload(item.activity, item.id, turnId) };
    case "image": return {
      id: item.id, type: item.type,
      image: { itemId: item.id, turnId, path: item.image.path, kind: item.image.kind, prompt: item.image.prompt },
      ...(item.activity ? { activity: activityPayload(item.activity, item.id, turnId) } : {}),
    };
    case "other": return { id: item.id, type: item.type };
  }
}

export function historyTurn(turn: ClaudeStoredTurn): HistoryTurn {
  return {
    id: turn.id, items: turn.items.map(item => historyItem(item, turn.id)), itemsView: "full", status: turn.status,
    error: turn.error ? { message: turn.error.message } : null,
    startedAt: turn.startedAt, completedAt: turn.completedAt, durationMs: turn.durationMs,
  };
}

function usageBreakdown(usage: ClaudeStoredUsage | null): TokenUsageBreakdown | null {
  return usage && {
    inputTokens: usage.inputTokens, cacheReadInputTokens: usage.cacheReadInputTokens, cacheWriteInputTokens: usage.cacheWriteInputTokens,
    outputTokens: usage.outputTokens, reasoningOutputTokens: usage.reasoningOutputTokens, totalTokens: usage.totalTokens,
  };
}

export function threadTokenUsage(usage: ClaudeStoredTokenUsage): ThreadTokenUsage {
  return { last: usageBreakdown(usage.last), total: usageBreakdown(usage.total), contextWindow: usage.contextWindow };
}
