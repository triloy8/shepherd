import type { AccountInfo, SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import type { AccountLimitStatus, AccountLimitWindow, ProviderAccountLimits } from "../../../shared/protocol/provider_account_limits.js";

const labels: Record<string, string> = {
  five_hour: "Five-hour allowance", seven_day: "Weekly allowance",
  seven_day_oauth_apps: "Weekly app allowance", seven_day_opus: "Weekly Opus allowance",
  seven_day_sonnet: "Weekly Sonnet allowance", seven_day_overage_included: "Weekly included allowance",
  overage: "Extra usage allowance",
};
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const percent = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
const timestamp = (value: unknown): number | null => {
  const seconds = typeof value === "string" ? Date.parse(value) / 1000 : value;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? seconds : null;
};
const status = (value: unknown): AccountLimitStatus | null => value === "allowed" ? "available" : value === "allowed_warning" ? "warning" : value === "rejected" ? "limited" : null;

export function claudeAccount(account: AccountInfo): ProviderAccountLimits["account"] {
  const plan = typeof account.subscriptionType === "string" && account.subscriptionType.trim() ? account.subscriptionType : null;
  const api = Boolean(account.apiProvider && account.apiProvider !== "firstParty")
    || ["ANTHROPIC_API_KEY", "apiKeyHelper", "/login managed key"].includes(account.apiKeySource ?? "");
  return { plan: api ? null : plan, authentication: api ? "api" : plan ? "subscription" : "unknown", signedIn: api || Boolean(plan || account.email || (account.tokenSource && account.tokenSource !== "none")) };
}

export function emptyClaudeLimits(account: AccountInfo = {}): ProviderAccountLimits {
  const identity = claudeAccount(account);
  return {
    provider: "claude", account: identity,
    availability: identity.authentication === "api" ? "not_applicable" : "unavailable",
    source: "none", checkedAt: null, stale: false, windows: [], extraUsage: null,
    message: identity.authentication === "api" ? "Subscription limits do not apply to this API account."
      : identity.signedIn ? "Claude has not reported subscription limits yet."
      : "Sign in to Claude Code on the Shepherd host to view subscription limits.",
  };
}

/** Experimental control reply: validate at this boundary rather than trusting SDK types. */
export function mapClaudeUsage(value: unknown, account: AccountInfo, now: number): ProviderAccountLimits | null {
  const reply = record(value);
  if (!reply || typeof reply.rate_limits_available !== "boolean") return null;
  const snapshot = emptyClaudeLimits(account);
  if (typeof reply.subscription_type === "string" && reply.subscription_type.trim() && snapshot.account.authentication !== "api") {
    snapshot.account = { plan: reply.subscription_type, authentication: "subscription", signedIn: true };
  }
  if (!reply.rate_limits_available) {
    snapshot.checkedAt = now;
    if (snapshot.account.signedIn && snapshot.availability !== "not_applicable") snapshot.message = "Claude subscription limits are unavailable for this login. A full Claude Code sign-in may be required.";
    return snapshot;
  }
  const limits = record(reply.rate_limits);
  if (!limits) return null;
  const windows: AccountLimitWindow[] = [];
  // Newer CLIs preserve the server's rows. An empty list is authoritative;
  // absent/null rows use the older, typed per-window fields instead.
  if (Array.isArray(limits.limits)) for (const [index, value] of limits.limits.entries()) {
    const row = record(value);
    if (!row || typeof row.kind !== "string") continue;
    const scope = record(row.scope);
    const model = record(scope?.model);
    const surface = record(scope?.surface);
    const display = typeof model?.display_name === "string" ? model.display_name
      : typeof surface?.display_name === "string" ? surface.display_name : null;
    const id = row.kind === "session" ? "five_hour" : row.kind === "weekly_all" ? "seven_day"
      : row.kind === "weekly_scoped" && display ? model ? ["opus", "sonnet"].includes(display.toLowerCase()) ? `seven_day_${display.toLowerCase()}` : `model:${display}` : `surface:${display}`
      : `kind:${row.kind}:${index}`;
    const label = labels[id] ?? (row.kind === "weekly_scoped" && display ? `Weekly ${display} allowance` : `${row.kind.replace(/[_-]+/g, " ")} allowance`);
    const uniqueId = windows.some(window => window.id === id) ? `${id}:${index}` : id;
    windows.push({ id: uniqueId, label, usedPercent: percent(row.percent), resetsAt: timestamp(row.resets_at), status: null, observedAt: now, stale: false });
  }
  else for (const id of ["five_hour", "seven_day", "seven_day_oauth_apps", "seven_day_opus", "seven_day_sonnet"]) {
    const row = record(limits[id]);
    if (row) windows.push({ id, label: labels[id]!, usedPercent: percent(row.utilization), resetsAt: timestamp(row.resets_at), status: null, observedAt: now, stale: false });
  }
  if (!Array.isArray(limits.limits) && Array.isArray(limits.model_scoped)) for (const value of limits.model_scoped) {
    const row = record(value);
    if (!row || typeof row.display_name !== "string" || !row.display_name.trim()) continue;
    const id = `model:${row.display_name}`;
    if (windows.some(window => window.id === id)) continue;
    windows.push({ id, label: `Weekly ${row.display_name} allowance`, usedPercent: percent(row.utilization), resetsAt: timestamp(row.resets_at), status: null, observedAt: now, stale: false });
  }
  const extra = record(limits.extra_usage);
  return { ...snapshot, availability: "available", source: "provider", checkedAt: now, windows,
    extraUsage: extra ? { enabled: typeof extra.is_enabled === "boolean" ? extra.is_enabled : null, usedPercent: percent(extra.utilization), active: null, status: null, observedAt: now, stale: false } : null,
    message: windows.length ? null : "Claude returned no subscription allowance windows for this account.",
  };
}

/** Event utilization is a fraction. Control-reply utilization is already a percent. */
export function mapClaudeRateLimit(info: SDKRateLimitInfo, now: number): { window: AccountLimitWindow; extraUsage: ProviderAccountLimits["extraUsage"] } | null {
  if (!record(info)) return null;
  const state = status(info.status);
  if (!state) return null;
  const id = info.rateLimitType ?? "current";
  const fraction = typeof info.utilization === "number" && Number.isFinite(info.utilization) && info.utilization >= 0 && info.utilization <= 1 ? info.utilization : null;
  const extraKnown = info.overageStatus !== undefined || info.isUsingOverage !== undefined || info.overageInUse !== undefined || info.overageEnabled !== undefined;
  return {
    window: { id, label: labels[id] ?? "Current allowance", usedPercent: fraction === null ? null : fraction * 100, resetsAt: timestamp(info.resetsAt), status: state, observedAt: now, stale: false },
    extraUsage: extraKnown ? { enabled: info.overageEnabled ?? null, usedPercent: null, active: info.overageInUse ?? info.isUsingOverage ?? null, status: status(info.overageStatus), observedAt: now, stale: false } : null,
  };
}
