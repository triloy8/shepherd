import { describe, expect, test } from "bun:test";
import { MessageFlags } from "discord.js";

import { handleInteraction } from "../server/adapters/discord/interactions.js";

describe("Discord interactions", () => {
  test("acknowledges approval button decisions with normalized text", async () => {
    const replies: Array<{ content: string; flags: MessageFlags }> = [];
    const interaction = {
      customId: "approval|thread-1|approval-1|approve",
      async reply(payload: { content: string; flags: MessageFlags }) {
        replies.push(payload);
      },
    };

    const conversation = {
      async applyApprovalDecision(
        threadId: string,
        approvalId: string,
        request: { decision: string },
      ) {
        expect(threadId).toBe("thread-1");
        expect(approvalId).toBe("approval-1");
        expect(request).toEqual({ decision: "approve" });
      },
    };

    await handleInteraction(interaction as never, conversation as never);

    expect(replies).toEqual([
      {
        content: "Approval decision recorded: Approved",
        flags: MessageFlags.Ephemeral,
      },
    ]);
  });
});
