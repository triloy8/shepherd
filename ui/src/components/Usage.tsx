import type { ThreadTokenUsage } from "../../../shared/protocol/requests";
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
const count = (value: unknown) => number(value)?.toLocaleString() ?? "Unknown";
const optional = (value: number | null) => value === null ? "Not reported" : count(value);

export function ContextUsage({ usage }: { usage: ThreadTokenUsage | null }) {
  if (!usage) return <p className="text-xs text-muted">No context telemetry yet. Send a turn first.</p>;
  return <dl className="settings-facts">
    <dt>Last turn tokens</dt><dd>{count(usage.last.totalTokens)}</dd>
    <dt>Context window</dt><dd>{count(usage.contextWindow)}</dd>
    <dt>Total tokens</dt><dd>{count(usage.total.totalTokens)}</dd>
    <dt>Input / cache read / cache write</dt><dd>{count(usage.total.inputTokens)} / {optional(usage.total.cacheReadInputTokens)} / {optional(usage.total.cacheWriteInputTokens)}</dd>
    <dt>Output / reasoning</dt><dd>{count(usage.total.outputTokens)} / {optional(usage.total.reasoningOutputTokens)}</dd>
  </dl>;
}
