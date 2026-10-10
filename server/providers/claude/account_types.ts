import type { AgentProvider } from "../../../shared/protocol/requests.js";

export type AccountLimitStatus = "available" | "warning" | "limited";

/** Account allowance, separate from conversation token/context telemetry. */
export interface AccountLimitWindow {
  id: string;
  label: string;
  usedPercent: number | null;
  resetsAt: number | null;
  status: AccountLimitStatus | null;
  observedAt: number;
  stale: boolean;
}

export interface ProviderAccountLimits {
  provider: AgentProvider;
  account: {
    plan: string | null;
    authentication: "subscription" | "api" | "unknown";
    signedIn: boolean;
  };
  availability: "available" | "unavailable" | "not_applicable";
  source: "provider" | "events" | "none";
  checkedAt: number | null;
  stale: boolean;
  windows: AccountLimitWindow[];
  extraUsage: {
    enabled: boolean | null;
    usedPercent: number | null;
    active: boolean | null;
    status: AccountLimitStatus | null;
    observedAt: number;
    stale: boolean;
  } | null;
  message: string | null;
}

export interface ReadProviderAccountLimitsOptions { refresh?: boolean; }
