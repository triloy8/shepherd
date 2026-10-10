import type { BoundedText } from "./conversation_items.js";
import type { ProviderId } from "./conversations.js";

export interface AccountLimitWindow {
  id: string; groupId: string | null; label: string; subtitle: string | null;
  durationMinutes: number | null; usedPercent: number | null; resetsAt: number | null;
  status: "available" | "warning" | "limited" | null;
  observedAt: number; stale: boolean;
}
export interface ResetCredit {
  id: string; supported: boolean; status: "available" | "redeeming" | "redeemed" | "unknown";
  grantedAt: number | null; expiresAt: number | null; title: string | null; description: BoundedText | null;
}
export interface ProviderAccountLimits {
  provider: ProviderId;
  account: { plan: string | null; authentication: "subscription" | "api" | "unknown"; signedIn: boolean };
  availability: "available" | "unavailable" | "not_applicable";
  source: "provider" | "events" | "none";
  checkedAt: number | null; stale: boolean; ordinaryUsageAllowed: boolean | null;
  windows: AccountLimitWindow[];
  extraUsage: {
    enabled: boolean | null; unlimited: boolean | null; balanceLabel: string | null;
    usedPercent: number | null; active: boolean | null; status: "available" | "warning" | "limited" | null;
    observedAt: number; stale: boolean;
  } | null;
  spendControls: Array<{
    id: string; label: string; limitLabel: string | null; usedLabel: string | null;
    remainingPercent: number | null; resetsAt: number | null; reached: boolean | null;
    observedAt: number; stale: boolean;
  }>;
  resets: { supported: boolean; availableCount: number | null; credits: ResetCredit[] | null };
  message: BoundedText | null;
}
