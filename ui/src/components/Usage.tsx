import type { ThreadTokenUsage } from "../../../shared/protocol/requests";
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
const count = (value: unknown) => number(value)?.toLocaleString() ?? "Unknown";

export function ContextUsage({ usage }: { usage: ThreadTokenUsage | null }) {
  if (!usage) return <p className="text-xs text-muted">No context telemetry yet. Send a turn first.</p>;
  return <dl className="settings-facts">
    <dt>Last turn tokens</dt><dd>{count(usage.last.totalTokens)}</dd>
    <dt>Context window</dt><dd>{count(usage.modelContextWindow)}</dd>
    <dt>Total tokens</dt><dd>{count(usage.total.totalTokens)}</dd>
    <dt>Input / cached</dt><dd>{count(usage.total.inputTokens)} / {count(usage.total.cachedInputTokens)}</dd>
    <dt>Output / reasoning</dt><dd>{count(usage.total.outputTokens)} / {count(usage.total.reasoningOutputTokens)}</dd>
  </dl>;
}

export function AccountLimits({ value }: { value: unknown }) {
  const limits = record(value); const credits = record(limits.credits);
  if (!Object.keys(limits).length) return <p className="text-xs text-muted">Account limits are unavailable.</p>;
  return <div className="space-y-3 text-xs text-muted">
    <p>Plan: {typeof limits.planType === "string" ? limits.planType : "Unknown"}</p>
    {(["primary", "secondary"] as const).map((key) => {
      const window = record(limits[key]); if (!Object.keys(window).length) return null;
      const reset = number(window.resetsAt); const date = reset === null ? null : new Date(reset * 1000);
      return <div key={key}><p className="text-ink">{key === "primary" ? "Primary" : "Secondary"} window: {count(window.usedPercent)}% used</p>
        <p>Window: {count(window.windowDurationMins)} minutes</p><p>Resets: {date && Number.isFinite(date.getTime()) ? date.toLocaleString() : "Unknown"}</p></div>;
    })}
    {Object.keys(credits).length > 0 && <p>Credits: {credits.unlimited === true ? "Unlimited" : typeof credits.balance === "string" ? credits.balance : credits.hasCredits === false ? "None" : "Unknown"}</p>}
  </div>;
}
