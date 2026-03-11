import { describe, expect, test } from "bun:test";

import type { ApprovalRequestPayload } from "../shared/protocol/approvals.js";
import type { BridgeEvent } from "../shared/protocol/events.js";
import {
  buildApprovalRows,
  createDiscordThreadEventHandler,
} from "../server/adapters/discord/thread_event_handler.js";

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

describe("Discord thread event handler", () => {
  test("builds approval button rows with encoded decisions", () => {
    const approval: ApprovalRequestPayload = {
      approvalId: "approval-1",
      method: "shell.exec",
      prompt: "Approve?",
      params: {},
      choices: [
        { value: "approve", label: "Approve" },
        { value: "reject", label: "Reject" },
      ],
    };

    const rows = buildApprovalRows("thread-1", approval);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.components).toHaveLength(2);
    expect(rows[0]?.components[0]?.data.custom_id).toBe("approval|thread-1|approval-1|approve");
    expect(rows[0]?.components[1]?.data.custom_id).toBe("approval|thread-1|approval-1|reject");
  });

  test("flushes streamed text to the channel on turn completion", async () => {
    const sent: string[] = [];
    const channel = {
      async send(content: string | { content: string }) {
        sent.push(typeof content === "string" ? content : content.content);
        return { id: `msg-${sent.length}` };
      },
      messages: {
        async fetch() {
          throw new Error("unexpected fetch");
        },
      },
    };

    const { handleThreadEvent } = createDiscordThreadEventHandler({
      channels: {
        async fetch() {
          return channel;
        },
      },
    });

    handleThreadEvent("chan-1", makeEvent("turn.started", { turnId: "turn-1" }));
    handleThreadEvent(
      "chan-1",
      makeEvent("turn.stream.delta", {
        method: "agentMessageDelta",
        textDelta: "hello",
        itemId: "item-1",
        phase: "final_answer",
      }),
    );
    handleThreadEvent("chan-1", makeEvent("turn.completed", { turnId: "turn-1" }));

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sent).toContain("hello");
  });
});
