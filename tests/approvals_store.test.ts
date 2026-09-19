import { expect, test } from "bun:test";
import { ApprovalsStore } from "../server/core/approvals.js";

test("invalid or cross-thread decisions leave an approval pending and the first valid decision wins", () => {
  const store = new ApprovalsStore();
  store.create({ approvalId: "id", method: "item/commandExecution/requestApproval", prompt: "Allow?", choices: [{ value: "accept", label: "Accept" }, { value: "decline", label: "Decline" }], params: {} }, { threadId: "thread", sessionId: "session" });
  expect(() => store.markDecided("other", "id", { decision: "accept" })).toThrow("not found");
  expect(() => store.markDecided("thread", "id", { decision: "acceptBogus" })).toThrow("choices");
  expect(store.listByThread("thread")[0]!.status).toBe("pending");
  store.markDecided("thread", "id", { decision: "accept" });
  expect(() => store.markDecided("thread", "id", { decision: "decline" })).toThrow("already");
  expect(store.listByThread("thread")[0]!.status).toBe("approved");
});
