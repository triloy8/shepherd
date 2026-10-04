import { expect, test } from "bun:test";
import { decodeResetCredits, decodeResetOutcome } from "../server/core/account_usage";

const credit = { id: "credit-1", resetType: "codexRateLimits", status: "available", grantedAt: 100, expiresAt: 200, title: "Reset", description: null };
test("reset summaries preserve count-only, empty, capped and non-expiring details", () => {
  expect(decodeResetCredits(null)).toBeNull();
  expect(decodeResetCredits({ availableCount: 2, credits: null })).toEqual({ availableCount: 2, credits: null });
  expect(decodeResetCredits({ availableCount: 0, credits: [] })).toEqual({ availableCount: 0, credits: [] });
  expect(decodeResetCredits({ availableCount: 3, credits: [credit, { ...credit, id: "credit-2", expiresAt: null }] })).toEqual({ availableCount: 3, credits: [credit, { ...credit, id: "credit-2", expiresAt: null }] });
});
test("malformed reset data cannot enable redemption or render invalid rows", () => {
  for (const availableCount of [-1, 0.5, NaN, Infinity, "2", Number.MAX_SAFE_INTEGER + 1]) expect(decodeResetCredits({ availableCount })).toBeNull();
  expect(decodeResetCredits({ availableCount: 1, credits: [{ ...credit, id: "" }, { ...credit, expiresAt: "tomorrow" }, { ...credit, grantedAt: NaN }] })?.credits).toEqual([]);
  expect(decodeResetCredits({ availableCount: 1, credits: [{ ...credit, resetType: "future", status: "future" }] })?.credits?.[0]).toMatchObject({ resetType: "unknown", status: "unknown" });
});
test("reset outcomes are explicit; unknown responses must not claim success", () => {
  for (const outcome of ["reset", "alreadyRedeemed", "nothingToReset", "noCredit"]) expect(decodeResetOutcome({ outcome })).toEqual({ outcome });
  for (const value of [null, {}, { outcome: "maybe" }]) expect(() => decodeResetOutcome(value)).toThrow("unrecognized reset outcome");
});
