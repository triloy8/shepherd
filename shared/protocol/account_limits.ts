type ProviderId = string;

export interface AccountLimitWindow {
  id: string; groupId: string | null; label: string; subtitle: string | null;
  durationMinutes: number | null; usedPercent: number | null; resetsAt: number | null;
  status: "available" | "warning" | "limited" | null;
  observedAt: number; stale: boolean;
}
export interface ResetCredit {
  id: string; supported: boolean; status: "available" | "redeeming" | "redeemed" | "unknown";
  grantedAt: number | null; expiresAt: number | null; title: string | null; description: string | null;
}
/** One agent account's usage. Every section is optional for a provider: one that has no such
 * concept reports null fields, an empty list, or null counts rather than inventing values. */
export interface ProviderAccountLimits {
  provider: ProviderId;
  account: { plan: string | null; authentication: "subscription" | "api" | "unknown"; signedIn: boolean | null };
  availability: "available" | "unavailable" | "not_applicable";
  source: "provider" | "events" | "none";
  checkedAt: number | null; stale: boolean; ordinaryUsageAllowed: boolean | null;
  /** Allowance windows that reset over time, such as a five-hour or weekly allowance. */
  windows: AccountLimitWindow[];
  /** Usage beyond the allowance windows, such as purchased credits or pay-as-you-go overage. */
  extraUsage: {
    enabled: boolean | null; unlimited: boolean | null; balanceLabel: string | null;
    usedPercent: number | null; active: boolean | null; status: "available" | "warning" | "limited" | null;
    observedAt: number; stale: boolean;
  } | null;
  /** Credits that reset allowance windows early. Availability data only; operation support is
   * ProviderCapabilities.accountReset. */
  resets: { availableCount: number | null; credits: ResetCredit[] | null };
  message: string | null;
}

export type AccountResetRequest = { idempotencyKey: string; creditId?: string };
export type AccountResetResponse = { outcome: "reset" | "already_redeemed" | "nothing_to_reset" | "no_credit" };
