export interface RateLimitResetCredit {
  id: string;
  resetType: "codexRateLimits" | "unknown";
  status: "available" | "redeeming" | "redeemed" | "unknown";
  grantedAt: number;
  expiresAt: number | null;
  title: string | null;
  description: string | null;
}
export interface RateLimitResetCredits {
  availableCount: number;
  credits: RateLimitResetCredit[] | null;
}
export interface ConsumeRateLimitResetRequest {
  idempotencyKey: string;
  creditId?: string;
}
export interface ConsumeRateLimitResetResponse {
  outcome: "reset" | "alreadyRedeemed" | "nothingToReset" | "noCredit";
}

export interface AccountRateLimitsResponse {
  rateLimits: unknown;
  rateLimitsByLimitId: Record<string, unknown> | null;
  rateLimitResetCredits: RateLimitResetCredits | null;
}
