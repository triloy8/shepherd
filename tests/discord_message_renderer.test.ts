import { describe, expect, test } from "bun:test";

import type { ApprovalRequestPayload } from "../shared/protocol/approvals.js";
import type { BridgeEvent } from "../shared/protocol/events.js";
import {
  approvalRequestLines,
  formatActivityLine,
  formatApprovalDecisionLabel,
  formatApprovalDecisionReply,
  formatApprovalText,
  formatEventLine,
} from "../server/adapters/discord/message_renderer.js";

function makeEvent<K extends BridgeEvent["type"]>(type: K, payload: import("../shared/protocol/events.js").BridgeEventPayloads[K]): import("../shared/protocol/events.js").BridgeEventOf<K> {
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
      kind: "permission",
      activity: { kind: "command", command: "bun install", cwd: "/repo" },
      reason: "Dependencies changed.",
      choices: [
        { value: "approve", label: "Approve", intent: "allow" },
        { value: "reject", label: "Reject", intent: "deny" },
      ],
    };

    expect(formatApprovalText(approval)).toBe(
      "Approval Required\n\nAction: permission\n\nAllow this command?\nDependencies changed.\nbun install\n\nOptions: Approve / Reject",
    );
  });

  test("writes approval prompts from the activity and redacts secrets in them", () => {
    const lines = approvalRequestLines({
      approvalId: "approval-2", kind: "permission", reason: null, choices: [],
      activity: { kind: "command", command: "API_TOKEN=super-secret deploy", cwd: null },
    });
    expect(lines).toEqual(["Allow this command?", "API_TOKEN=[REDACTED] deploy"]);
    expect(approvalRequestLines({
      approvalId: "approval-3", kind: "permission", reason: null, choices: [],
      activity: { kind: "tool", source: "mcp", server: "github", name: "merge_pr", target: null },
    })).toEqual(["Allow github.merge_pr?"]);
  });

  test("labels approval outcomes by declared intent, never by the provider's wording", () => {
    expect(formatApprovalDecisionLabel({ intent: "allow", label: "Approved" })).toBe("Approved");
    expect(formatApprovalDecisionLabel({ intent: "allow", label: "Allow for session" })).toBe("Approved (Allow for session)");
    // Wording that reads like another outcome does not change the declared intent.
    expect(formatApprovalDecisionLabel({ intent: "deny", label: "Accept the risk later" })).toBe("Declined (Accept the risk later)");
    expect(formatApprovalDecisionLabel({ intent: "cancel", label: "Skip" })).toBe("Cancelled (Skip)");
    expect(formatApprovalDecisionLabel(undefined)).toBe("Submitted");
  });

  test("formats approval acknowledgement replies", () => {
    expect(formatApprovalDecisionReply({ intent: "allow", label: "Approve" })).toBe("Approval decision recorded: Approved (Approve)");
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

  test("surfaces shared errors without requiring native notification methods", () => {
    expect(formatEventLine(makeEvent("session.error", { message: "Tool failed" }))).toBe("Session Error\n\nTool failed");
    expect(formatEventLine(makeEvent("item.started", { turnId: null, item: { id: "activity", type: "activity", status: "started", activity: { kind: "command", command: "bun test", cwd: null } } }))).toBeNull();
  });

  test("renders concise activity lines and redacts command secrets", () => {
    expect(
      formatActivityLine({
        itemId: "command-1",
        turnId: "turn-1",
        activity: { kind: "command", command: "API_TOKEN=super-secret bun test", cwd: null },
        status: "started",
      }),
    ).toBe("🔧 Running command: API_TOKEN=[REDACTED] bun test");
    expect(
      formatActivityLine({
        itemId: "command-2",
        turnId: "turn-1",
        activity: { kind: "command", command: "tool --api-key hidden-value --token=second-secret", cwd: null },
        status: "started",
      }),
    ).toBe("🔧 Running command: tool --api-key [REDACTED] --token=[REDACTED]");
    expect(
      formatActivityLine({
        itemId: "command-3",
        turnId: "turn-1",
        activity: { kind: "command", command: "just launch-signaled run-specs/gpu-smoke.json SPEND http://127.0.0.1:8787/signals/abcdefghijklmnopqrstuvwx", cwd: null },
        status: "started",
      }),
    ).toBe(
      "🔧 Running command: just launch-signaled run-specs/gpu-smoke.json SPEND [REDACTED_SIGNAL_URL]",
    );
    expect(
      formatActivityLine({
        itemId: "tool-1",
        turnId: "turn-1",
        activity: { kind: "tool", source: "mcp", server: "github", name: "get_pull_request", target: null },
        status: "failed",
      }),
    ).toBe("⚠️ Calling MCP tool failed: github.get_pull_request");
  });

  test("truncates oversized activity details", () => {
    const line = formatActivityLine({
      itemId: "command-1",
      turnId: "turn-1",
      activity: { kind: "command", command: "x".repeat(500), cwd: null },
      status: "started",
    });
    expect(line.endsWith("…")).toBe(true);
    expect(Array.from(line).length).toBeLessThan(190);
  });
});
