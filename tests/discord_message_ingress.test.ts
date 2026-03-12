import { describe, expect, test } from "bun:test";

import { processDiscordMessage } from "../server/adapters/discord/message_ingress.js";

function makeMessage(content: string, mentioned = false) {
  const replies: string[] = [];
  return {
    message: {
      content,
      channelId: "chan-1",
      mentions: {
        users: {
          has(id: string) {
            return mentioned && id === "bot-1";
          },
        },
      },
      async reply(text: string) {
        replies.push(text);
        return {} as never;
      },
    },
    replies,
  };
}

describe("Discord message ingress", () => {
  test("ignores non-command input that does not mention the bot", async () => {
    const { message } = makeMessage("hello", false);
    let handled = false;

    await processDiscordMessage(message as never, {
      botUserId: "bot-1",
      conversation: {} as never,
      commandContext: {} as never,
      approvalPolicy: "on-request",
      async handleCommandMessage() {
        handled = true;
        return { handled: true, threadId: null, input: null };
      },
      async executeRouting() {
        handled = true;
        return { type: "ignore" } as const;
      },
    });

    expect(handled).toBe(false);
  });

  test("sanitizes mentions before delegating to command handling and routing", async () => {
    const { message } = makeMessage("<@bot-1> summarize this", true);
    const seen: { content?: string; routedInput?: string | null } = {};

    await processDiscordMessage(message as never, {
      botUserId: "bot-1",
      conversation: {} as never,
      commandContext: {} as never,
      approvalPolicy: "on-request",
      async handleCommandMessage(_message, _context, contentOverride) {
        seen.content = contentOverride;
        return { handled: false, threadId: "thread-1", input: contentOverride ?? null };
      },
      async executeRouting(_context, input) {
        seen.routedInput = input.input;
        return { type: "submit", threadId: "thread-1", turnId: "turn-1" } as const;
      },
    });

    expect(seen).toEqual({
      content: "summarize this",
      routedInput: "summarize this",
    });
  });
});
