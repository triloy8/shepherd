import { describe, expect, test } from "bun:test";
import { ComponentType, MessageFlags } from "discord.js";

import { handleInteraction } from "../server/adapters/discord/interactions.js";

function textContent(payload: unknown): string {
  const components = (payload as { components?: unknown[] }).components ?? [];
  const first = components[0];
  const component = (first && typeof first === "object" && "toJSON" in first
    ? (first as { toJSON: () => unknown }).toJSON()
    : first) as { type?: unknown; content?: unknown };
  expect(component.type).toBe(ComponentType.TextDisplay);
  return String(component.content);
}

describe("Discord interactions", () => {
  test("acknowledges approval decisions with an ephemeral Text Display", async () => {
    const replies: unknown[] = [];
    const interaction = {
      customId: "approval|thread-1|approval-1|approve",
      async reply(payload: unknown) {
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

    expect(replies).toHaveLength(1);
    expect(textContent(replies[0])).toBe("Approval decision recorded: Approved");
    expect((replies[0] as { flags?: unknown }).flags).toBe(
      MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
    );
    expect((replies[0] as { allowedMentions?: unknown }).allowedMentions).toEqual({ parse: [] });
  });

  test("falls back to ephemeral content when Components V2 is rejected", async () => {
    const replies: unknown[] = [];
    const interaction = {
      customId: "approval|thread-1|approval-1|reject",
      async reply(payload: unknown) {
        if ((payload as { components?: unknown[] }).components) {
          throw Object.assign(new Error("Invalid Form Body: IS_COMPONENTS_V2"), { code: 50_035 });
        }
        replies.push(payload);
      },
    };
    const conversation = { async applyApprovalDecision() {} };

    await handleInteraction(interaction as never, conversation as never);

    expect(replies).toEqual([
      {
        content: "Approval decision recorded: Declined",
        flags: MessageFlags.Ephemeral,
      },
    ]);
  });
});
