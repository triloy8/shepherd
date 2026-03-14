import { describe, expect, test } from "bun:test";

import type { ApprovalRequestPayload } from "../shared/protocol/approvals.js";
import type { BridgeEvent } from "../shared/protocol/events.js";
import {
  formatApprovalDecisionLabel,
  formatApprovalDecisionReply,
  formatApprovalText,
  formatEventLine,
} from "../server/adapters/discord/message_renderer.js";

function makeEvent<TPayload>(type: BridgeEvent["type"], payload: TPayload): BridgeEvent<TPayload> {
  return {
    id: "evt-1",
    type,
    threadId: "thread-1",
    sessionId: "session-1",
    ts: new Date().toISOString(),
    payload,
  };
}

describe("Discord message renderer", () => {
  test("formats approval prompts with a structured layout", () => {
    const approval: ApprovalRequestPayload = {
      approvalId: "approval-1",
      method: "shell.exec",
      prompt: "Run `bun install` in the workspace?",
      params: {},
      choices: [
        { value: "approve", label: "Approve" },
        { value: "reject", label: "Reject" },
      ],
    };

    expect(formatApprovalText(approval)).toBe(
      "Approval Required\n\nAction: shell.exec\n\nRun `bun install` in the workspace?\n\nOptions: Approve / Reject",
    );
  });

  test("normalizes common approval decisions into user-facing labels", () => {
    expect(formatApprovalDecisionLabel("approve")).toBe("Approved");
    expect(formatApprovalDecisionLabel("reject")).toBe("Declined");
    expect(formatApprovalDecisionLabel("allow-once")).toBe("allow-once");
  });

  test("formats approval acknowledgement replies", () => {
    expect(formatApprovalDecisionReply("approve")).toBe("Approval decision recorded: Approved");
  });

  test("formats high-signal event messages as status blocks", () => {
    expect(formatEventLine(makeEvent("session.error", { message: "Lost connection to app-server." }))).toBe(
      "Session Error\n\nLost connection to app-server.",
    );
    expect(formatEventLine(makeEvent("session.limit.context", { message: "limit", method: "turn.start" }))).toBe(
      "Context Limit Reached\n\nTry `!compact` or start a new thread.",
    );
    expect(formatEventLine(makeEvent("approval.failed", { approvalId: "approval-1", message: "Approval expired." }))).toBe(
      "Approval Failed\n\nApproval expired.",
    );
  });

  test("formats thread and turn events with clearer wording", () => {
    expect(formatEventLine(makeEvent("thread.name.updated", { threadName: "release prep" }))).toBe(
      "Thread Updated\n\nName: release prep",
    );
    expect(formatEventLine(makeEvent("thread.archived", {}))).toBe("Thread archived.");
    expect(formatEventLine(makeEvent("thread.unarchived", {}))).toBe("Thread unarchived.");
    expect(formatEventLine(makeEvent("turn.failed", { message: "Tool execution failed." }))).toBe(
      "Turn Failed\n\nTool execution failed.",
    );
  });

  test("only surfaces failing notification events", () => {
    expect(formatEventLine(makeEvent("turn.notification", { method: "tool.failed" }))).toBe(
      "Event Error\n\nEvent: tool.failed",
    );
    expect(formatEventLine(makeEvent("turn.notification", { method: "tool.started" }))).toBeNull();
  });
});
