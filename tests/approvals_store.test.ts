import { expect, test } from "bun:test";
import { ApprovalsStore } from "../server/core/approvals.js";

test("invalid or cross-thread decisions leave an approval pending and the first valid decision wins", () => {
  const store = new ApprovalsStore();
  const record = store.create({ approvalId: "id", kind: "permission", prompt: "Allow?", choices: [{ value: "accept", label: "Accept", intent: "allow" }, { value: "decline", label: "Decline", intent: "deny" }], detail: null }, { threadId: "thread", sessionId: "session" });
  expect(() => store.markDecided("other", record.approvalId, { decision: "accept" })).toThrow("not found");
  expect(() => store.markDecided("thread", record.approvalId, { decision: "acceptBogus" })).toThrow("choices");
  expect(store.listByThread("thread")[0]!.status).toBe("pending");
  store.markDecided("thread", record.approvalId, { decision: "accept" });
  expect(() => store.markDecided("thread", record.approvalId, { decision: "decline" })).toThrow("already");
  expect(store.listByThread("thread")[0]!.status).toBe("approved");
});

test("reused native approval IDs retain immutable occurrences and reject stale or foreign-session decisions", () => {
  const store = new ApprovalsStore();
  const request = { approvalId: "1", kind: "permission" as const, prompt: "Old", detail: null, choices: [{ value: "allow", label: "Allow", intent: "allow" as const }] };
  const old = store.create(request, { threadId: "t", sessionId: "s", turnId: "turn", requestEventId: "old-event" });
  request.prompt = "New";
  const newer = store.create(request, { threadId: "t", sessionId: "s", turnId: "turn", requestEventId: "new-event" });
  expect(newer.approvalId).not.toBe(old.approvalId);
  expect(store.listByThread("t").map(a => [a.prompt, a.status])).toEqual([["Old", "expired"], ["New", "pending"]]);
  expect(() => store.markDecided("t", old.approvalId, { decision: "allow" })).toThrow("expired");
  expect(() => store.markDecided("t", newer.approvalId, { decision: "allow" }, "foreign-session")).toThrow("earlier session");
  expect(store.resolveNative("t", "s", "1")).toBeNull();
  expect(store.resolveNative("t", "s", "1", "turn")).toBeNull();
  expect(store.resolveNative("t", "s", "1", undefined, "new-event")?.approvalId).toBe(newer.approvalId);
  expect(store.markDecided("t", newer.approvalId, { decision: "allow" }, "s").nativeApprovalId).toBe("1");
});
