import type { ProviderAccountLimits } from "../../../shared/protocol/v2/account_limits.js";
import type { ProviderAccountLimits as ObservedLimits } from "../../../shared/protocol/provider_account_limits.js";
import { boundText } from "../../../shared/protocol/v2/budgets.js";
export function claudeAccount(value: ObservedLimits): ProviderAccountLimits {
  return { ...value, ordinaryUsageAllowed: value.availability === "available" ? value.windows.some(window => window.status === "limited") ? false : value.windows.length && value.windows.every(window => window.usedPercent !== null) ? true : null : null,
    windows: value.windows.map(window => ({ ...window, groupId: null, subtitle: null, durationMinutes: window.id.startsWith("five_hour") ? 300 : window.id.startsWith("seven_day") ? 10080 : null })),
    extraUsage: value.extraUsage ? { ...value.extraUsage, unlimited: null, balanceLabel: null } : null,
    spendControls: [], resets: { supported: false, availableCount: null, credits: null }, message: value.message ? boundText(value.message) : null };
}
