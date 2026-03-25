import { describe, expect, test } from "bun:test";

import { processDiscordMessage } from "../server/adapters/discord/message_ingress.js";
import { toTextUserInput } from "../shared/protocol/user_input.js";

function makeMessage(
  content: string,
  mentioned = false,
  attachments: Array<{ url: string; contentType?: string | null; name?: string | null }> = [],
) {
  const replies: string[] = [];
  return {
    message: {
      content,
      channelId: "chan-1",
      attachments: {
        values() {
          return attachments.values();
        },
      },
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
    const seen: { content?: string; routedInput?: unknown } = {};

    await processDiscordMessage(message as never, {
      botUserId: "bot-1",
      conversation: {} as never,
      commandContext: {} as never,
      approvalPolicy: "on-request",
      async handleCommandMessage(_message, _context, contentOverride) {
        seen.content = contentOverride;
        return { handled: false, threadId: "thread-1", input: contentOverride ? [toTextUserInput(contentOverride)] : null };
      },
      async executeRouting(_context, input) {
        seen.routedInput = input.input;
        return { type: "submit", threadId: "thread-1", turnId: "turn-1" } as const;
      },
    });

    expect(seen).toEqual({
      content: "summarize this",
      routedInput: [toTextUserInput("summarize this")],
    });
  });

  test("routes image-only mentioned messages with remote image input", async () => {
    const { message } = makeMessage("<@bot-1>", true, [
      { url: "https://cdn.discordapp.com/test.png", contentType: "image/png", name: "test.png" },
    ]);
    const seen: { routedInput?: unknown } = {};

    await processDiscordMessage(message as never, {
      botUserId: "bot-1",
      conversation: {} as never,
      commandContext: {
        getSurfaceThreadId() {
          return "thread-1";
        },
      } as never,
      approvalPolicy: "on-request",
      async handleCommandMessage() {
        throw new Error("unexpected command handling");
      },
      async executeRouting(_context, input) {
        seen.routedInput = input.input;
        return { type: "submit", threadId: "thread-1", turnId: "turn-1" } as const;
      },
    });

    expect(seen).toEqual({
      routedInput: [{ type: "image", url: "https://cdn.discordapp.com/test.png" }],
    });
  });

  test("routes text plus image messages without dropping the image attachment", async () => {
    const { message } = makeMessage("<@bot-1> describe this", true, [
      { url: "https://cdn.discordapp.com/test.png", contentType: "image/png", name: "test.png" },
    ]);
    const seen: { routedInput?: unknown } = {};

    await processDiscordMessage(message as never, {
      botUserId: "bot-1",
      conversation: {} as never,
      commandContext: {} as never,
      approvalPolicy: "on-request",
      async handleCommandMessage(_message, _context, contentOverride) {
        return {
          handled: false,
          threadId: "thread-1",
          input: contentOverride ? [toTextUserInput(contentOverride)] : null,
        };
      },
      async executeRouting(_context, input) {
        seen.routedInput = input.input;
        return { type: "submit", threadId: "thread-1", turnId: "turn-1" } as const;
      },
    });

    expect(seen).toEqual({
      routedInput: [
        toTextUserInput("describe this"),
        { type: "image", url: "https://cdn.discordapp.com/test.png" },
      ],
    });
  });
});
