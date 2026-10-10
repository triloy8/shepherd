import type { ProviderAccountLimits } from "../../../shared/protocol/account_limits.js";
import type { AccountRateLimitsResponse } from "./account_types.js";
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const string = (value: unknown): string | null => typeof value === "string" && value.trim() ? value : null;
const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;

export function codexAccount(value: AccountRateLimitsResponse, now = Date.now() / 1000): ProviderAccountLimits {
  const groups = value.rateLimitsByLimitId && Object.keys(value.rateLimitsByLimitId).length ? value.rateLimitsByLimitId : { account: value.rateLimits }, windows: ProviderAccountLimits["windows"] = [];
  for (const [id, value] of Object.entries(groups)) {
    const group = record(value);
    for (const key of ["primary", "secondary"]) {
      const window = record(group[key]); if (!Object.keys(window).length) continue;
      const used = finite(window.usedPercent);
      windows.push({ id: `${id}:${key}`, groupId: id, label: string(group.limitName) ?? string(group.limitId) ?? "Account allowance", subtitle: key === "primary" ? "Primary window" : "Secondary window",
        durationMinutes: finite(window.windowDurationMins), usedPercent: used, resetsAt: finite(window.resetsAt), status: used === null ? null : used >= 100 ? "limited" : used >= 90 ? "warning" : "available", observedAt: now, stale: false });
    }
  }
  const main = record(value.rateLimits), credits = record(main.credits), resets = value.rateLimitResetCredits;
  return { provider: "codex", account: { plan: string(main.planType), authentication: "unknown", signedIn: windows.length > 0 }, availability: windows.length ? "available" : "unavailable", source: "provider", checkedAt: now, stale: false,
    ordinaryUsageAllowed: windows.length ? windows.some(window => window.status === "limited") ? false : windows.every(window => window.usedPercent !== null) ? true : null : null, windows,
    extraUsage: Object.keys(credits).length ? { enabled: typeof credits.hasCredits === "boolean" ? credits.hasCredits : null, unlimited: typeof credits.unlimited === "boolean" ? credits.unlimited : null, balanceLabel: string(credits.balance), usedPercent: null, active: null, status: null, observedAt: now, stale: false } : null,
    spendControls: [], resets: { supported: true, availableCount: resets?.availableCount ?? null, credits: resets?.credits?.map(credit => ({ id: credit.id, supported: credit.resetType === "codexRateLimits", status: credit.status, grantedAt: credit.grantedAt, expiresAt: credit.expiresAt, title: credit.title, description: credit.description ? credit.description : null })) ?? null }, message: windows.length ? null : "The provider has not reported account allowance windows." };
}
