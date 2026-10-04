import type { ConsumeRateLimitResetResponse, RateLimitResetCredit, RateLimitResetCredits } from "../../shared/protocol/requests.js";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const timestamp = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function decodeResetCredits(value: unknown): RateLimitResetCredits | null {
  const summary = record(value);
  if (!Number.isSafeInteger(summary.availableCount) || (summary.availableCount as number) < 0) return null;
  const credits = Array.isArray(summary.credits) ? summary.credits.flatMap((value): RateLimitResetCredit[] => {
    const row = record(value);
    if (typeof row.id !== "string" || !row.id.trim() || !timestamp(row.grantedAt) || (row.expiresAt !== null && !timestamp(row.expiresAt))) return [];
    return [{
      id: row.id,
      resetType: row.resetType === "codexRateLimits" ? "codexRateLimits" : "unknown",
      status: row.status === "available" || row.status === "redeeming" || row.status === "redeemed" ? row.status : "unknown",
      grantedAt: row.grantedAt,
      expiresAt: row.expiresAt,
      title: typeof row.title === "string" ? row.title : null,
      description: typeof row.description === "string" ? row.description : null,
    }];
  }) : null;
  return { availableCount: summary.availableCount as number, credits };
}

export function decodeResetOutcome(value: unknown): ConsumeRateLimitResetResponse {
  const outcome = record(value).outcome;
  if (outcome !== "reset" && outcome !== "alreadyRedeemed" && outcome !== "nothingToReset" && outcome !== "noCredit") {
    throw new Error("Codex returned an unrecognized reset outcome. Retry with the same request key to check its result.");
  }
  return { outcome };
}
