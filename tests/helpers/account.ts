import type { ProviderAccountLimits } from "../../shared/protocol/account_limits";
export function account(provider = "fixture", plan = "fixture"): ProviderAccountLimits {
  return { provider, account: { plan, authentication: "unknown", signedIn: true }, availability: "available", source: "provider", checkedAt: 100, stale: false, ordinaryUsageAllowed: true,
    windows: [{ id: "window", groupId: null, label: "Session", subtitle: null, durationMinutes: 300, usedPercent: 25, resetsAt: 2000000000, status: "available", observedAt: 100, stale: false }],
    extraUsage: null, spendControls: [], resets: { supported: false, availableCount: null, credits: null }, message: null };
}
