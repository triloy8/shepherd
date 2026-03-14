import { describe, expect, test } from "bun:test";

import type { ApprovalRequestPayload } from "../shared/protocol/approvals.js";
import {
  formatApprovalDecisionLabel,
  formatApprovalDecisionReply,
  formatApprovalText,
} from "../server/adapters/discord/message_renderer.js";

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
});
