import { historyTurn } from "../history_mapper.js";
import type {  ReadThreadResponse, RevertThreadResponse, ThreadRecord, ListModelsResponse } from "../../../shared/protocol/requests.js";
import type { AccountRateLimitsResponse } from "./account_types.js";
import type { StoredThreadPage, LoadedThreadPage } from "../../ports/provider_session.js";
import { decodeResetCredits } from "./account_usage.js";
const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const asString = (value: unknown): string | null => typeof value === "string" && value.trim() ? value : null;

function thread(value: unknown): ThreadRecord {
  const record = asRecord(value);
  const id = asString(record.id);
  if (!id) throw new Error("Thread payload missing id.");
  return { id, name: asString(record.name), preview: asString(record.preview) ?? "",
    ...(typeof record.createdAt === "number" ? { createdAt: record.createdAt } : {}),
    ...(typeof record.updatedAt === "number" ? { updatedAt: record.updatedAt } : {}),
    ...(asString(record.cwd) ? { cwd: String(record.cwd) } : {}),
    ...(asString(record.modelProvider) ? { modelProvider: String(record.modelProvider) } : {}),
    source: asString(record.source) ?? asString(asRecord(record.source).kind),
    ...(Array.isArray(record.turns) ? { turns: record.turns.map(historyTurn) } : {}) };
}
export function readResponse(value: unknown): ReadThreadResponse { return { thread: thread(asRecord(value).thread) }; }
export function revertResponse(value: unknown): RevertThreadResponse {
  const record = asRecord(value);
  return { ...readResponse(value), turnsBackwardsCursor: asString(record.turnsBackwardsCursor), itemsBackwardsCursor: asString(record.itemsBackwardsCursor) };
}
export function storedResponse(value: unknown): StoredThreadPage {
  const record = asRecord(value);
  if (!Array.isArray(record.data)) throw new Error("Invalid stored thread page.");
  return { data: record.data.map(thread), nextCursor: asString(record.nextCursor), backwardsCursor: asString(record.backwardsCursor) };
}
export function loadedResponse(value: unknown): LoadedThreadPage {
  const record = asRecord(value);
  if (!Array.isArray(record.data) || record.data.some(id => !asString(id))) throw new Error("Invalid loaded thread page.");
  return { data: record.data as string[], nextCursor: asString(record.nextCursor) };
}
export function accountResponse(value: unknown): AccountRateLimitsResponse {
  const raw = asRecord(value);
  return { rateLimits: raw.rateLimits ?? raw, rateLimitsByLimitId: raw.rateLimitsByLimitId && typeof raw.rateLimitsByLimitId === "object" ? raw.rateLimitsByLimitId as Record<string, unknown> : null, rateLimitResetCredits: decodeResetCredits(raw.rateLimitResetCredits) };
}
export function modelsResponse(value: unknown): ListModelsResponse {
  const raw = asRecord(value);
  const items = Array.isArray(raw.data) ? raw.data : [];
    return {
      data: items.map((item) => {
        const record = asRecord(item);
        return {
          id: asString(record.id) ?? asString(record.model) ?? "unknown",
          model: asString(record.model) ?? "unknown",
          displayName: asString(record.displayName) ?? asString(record.model) ?? "unknown",
          description: asString(record.description) ?? "",
          hidden: record.hidden === true,
          isDefault: record.isDefault === true,
          defaultReasoningEffort: asString(record.defaultReasoningEffort),
          supportedReasoningEfforts: (Array.isArray(record.supportedReasoningEfforts) ? record.supportedReasoningEfforts : [])
            .map((value) => {
              const option = asRecord(value);
              return { reasoningEffort: asString(option.reasoningEffort) ?? "", description: asString(option.description) ?? "" };
            }).filter((option) => option.reasoningEffort),

        };
      }),
      nextCursor: asString(raw.nextCursor),
    };
  }
