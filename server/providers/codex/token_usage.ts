import type { ThreadTokenUsage, TokenUsageBreakdown } from "../../../shared/protocol/requests.js";
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const count = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

function breakdown(value: unknown): TokenUsageBreakdown | null {
  const native = record(value);
  const inputTokens = count(native.inputTokens), outputTokens = count(native.outputTokens);
  if (inputTokens === null || outputTokens === null) return null;
  return {
    inputTokens,
    cacheReadInputTokens: count(native.cachedInputTokens),
    cacheWriteInputTokens: null,
    outputTokens,
    reasoningOutputTokens: count(native.reasoningOutputTokens),
    totalTokens: count(native.totalTokens) ?? inputTokens + outputTokens,
  };
}

/** Decode Codex token usage notifications. Codex does not report cache writes. */
export function codexTokenUsage(value: unknown): ThreadTokenUsage | null {
  const native = record(value);
  const last = breakdown(native.last), total = breakdown(native.total);
  if (!last || !total) return null;
  return { last, total, contextWindow: count(native.modelContextWindow) };
}
