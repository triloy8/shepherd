import { describe, expect, test } from "bun:test";

import { processDiscordMessage } from "../server/adapters/discord/message_ingress.js";
import { toTextUserInput } from "../shared/protocol/user_input.js";

function makeMessage(
  content: string,
  mentioned = false,
  attachments: Array<{
    url: string;
    contentType?: string | null;
    name?: string | null;
    size?: number;
  }> = [],
  guildId: string | null = "guild-1",
) {
  const replies: string[] = [];
  const reactions: string[] = [];
  return {
    message: {
      content,
      channelId: "chan-1",
      guildId,
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
      async react(emoji: string) {
        reactions.push(emoji);
        return {} as never;
      },
    },
    replies,
    reactions,
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

  test("routes unmentioned messages when the channel is open", async () => {
    const { message } = makeMessage("continue", false);
    const seen: { routedInput?: unknown } = {};

    await processDiscordMessage(message as never, {
      botUserId: "bot-1",
      conversation: {} as never,
      commandContext: {
        getSurfaceListeningMode() {
          return "open";
        },
      } as never,
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
        expect(input.surface.isDirectAddressed).toBe(true);
        return { type: "submit", threadId: "thread-1", turnId: "turn-1" } as const;
      },
    });

    expect(seen.routedInput).toEqual([toTextUserInput("continue")]);
  });

  test("routes direct messages without requiring a mention", async () => {
    const { message } = makeMessage("hello from a DM", false, [], null);
    let routed = false;

    await processDiscordMessage(message as never, {
      botUserId: "bot-1",
      conversation: {} as never,
      commandContext: {} as never,
      approvalPolicy: "on-request",
      async handleCommandMessage() {
        return { handled: false, threadId: "thread-1", input: [toTextUserInput("hello from a DM")] };
      },
      async executeRouting() {
        routed = true;
        return { type: "submit", threadId: "thread-1", turnId: "turn-1" } as const;
      },
    });

    expect(routed).toBe(true);
  });

  test("ignores conversation messages while paused, even when mentioned", async () => {
    const { message } = makeMessage("<@bot-1> continue", true);
    let handled = false;

    await processDiscordMessage(message as never, {
      botUserId: "bot-1",
      conversation: {} as never,
      commandContext: {
        getSurfaceListeningMode() {
          return "paused";
        },
      } as never,
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

  test("keeps control commands available while paused", async () => {
    const { message } = makeMessage("!resume", false);
    let handled = false;

    await processDiscordMessage(message as never, {
      botUserId: "bot-1",
      conversation: {} as never,
      commandContext: {
        getSurfaceListeningMode() {
          return "paused";
        },
      } as never,
      approvalPolicy: "on-request",
      async handleCommandMessage() {
        handled = true;
        return { handled: true, threadId: "thread-1", input: null };
      },
      async executeRouting() {
        return { type: "ignore" } as const;
      },
    });

    expect(handled).toBe(true);
  });

  test("does not download unaddressed audio attachments", async () => {
    const { message } = makeMessage("", false, [
      {
        url: "https://cdn.discordapp.com/voice-message.ogg",
        contentType: "audio/ogg",
        name: "voice-message.ogg",
      },
    ]);
    let fetched = false;

    await processDiscordMessage(message as never, {
      botUserId: "bot-1",
      conversation: {} as never,
      commandContext: {} as never,
      approvalPolicy: "on-request",
      async fetchAudio() {
        fetched = true;
        throw new Error("unexpected fetch");
      },
    });

    expect(fetched).toBe(false);
  });

  test("routes image-only mentioned messages with inline image input", async () => {
    const { message } = makeMessage("<@bot-1>", true, [
      { url: "https://cdn.discordapp.com/test.png", contentType: "image/png", name: "test.png" },
    ]);
    const seen: { routedInput?: unknown } = {};
    const imageBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);

    await processDiscordMessage(message as never, {
      botUserId: "bot-1",
      conversation: {} as never,
      commandContext: {
        getSurfaceThreadId() {
          return "thread-1";
        },
      } as never,
      approvalPolicy: "on-request",
      async fetchImage() {
        return new Response(imageBytes, {
          headers: { "content-type": "image/png" },
        });
      },
      async handleCommandMessage() {
        throw new Error("unexpected command handling");
      },
      async executeRouting(_context, input) {
        seen.routedInput = input.input;
        return { type: "submit", threadId: "thread-1", turnId: "turn-1" } as const;
      },
    });

    expect(seen).toEqual({
      routedInput: [{ type: "image", url: "data:image/png;base64,iVBORw0KGgo=" }],
    });
  });

  test("routes text plus image messages without dropping the image attachment", async () => {
    const { message } = makeMessage("<@bot-1> describe this", true, [
      { url: "https://cdn.discordapp.com/test.jpg", contentType: "image/jpeg", name: "test.jpg" },
    ]);
    const seen: { routedInput?: unknown } = {};
    const imageBytes = new Uint8Array([0xff, 0xd8, 0xff]);

    await processDiscordMessage(message as never, {
      botUserId: "bot-1",
      conversation: {} as never,
      commandContext: {} as never,
      approvalPolicy: "on-request",
      async fetchImage() {
        return new Response(imageBytes, {
          headers: { "content-type": "image/jpeg" },
        });
      },
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
        { type: "image", url: "data:image/jpeg;base64,/9j/" },
      ],
    });
  });

  test("routes Discord voice messages as native inline audio input", async () => {
    const { message, reactions } = makeMessage("<@bot-1>", true, [
      {
        url: "https://cdn.discordapp.com/voice-message.ogg",
        contentType: "audio/ogg; codecs=opus",
        name: "voice-message.ogg",
      },
    ]);
    const seen: { routedInput?: unknown } = {};
    const audioBytes = new TextEncoder().encode("OggS\0OpusHead");

    await processDiscordMessage(message as never, {
      botUserId: "bot-1",
      conversation: {} as never,
      commandContext: {
        getSurfaceThreadId() {
          return "thread-1";
        },
      } as never,
      approvalPolicy: "on-request",
      async fetchAudio() {
        return new Response(audioBytes, {
          headers: { "content-type": "audio/ogg" },
        });
      },
      async handleCommandMessage() {
        throw new Error("unexpected command handling");
      },
      async executeRouting(_context, input) {
        seen.routedInput = input.input;
        return { type: "submit", threadId: "thread-1", turnId: "turn-1" } as const;
      },
    });

    expect(seen).toEqual({
      routedInput: [
        {
          type: "audio",
          url: `data:audio/ogg;base64,${Buffer.from(audioBytes).toString("base64")}`,
        },
      ],
    });
    expect(reactions).toEqual(["🎙️"]);
  });

  test("routes native voice messages without mentions in an open channel", async () => {
    const { message, reactions } = makeMessage("", false, [
      {
        url: "https://cdn.discordapp.com/voice-message.ogg",
        contentType: "audio/ogg; codecs=opus",
        name: "voice-message.ogg",
      },
    ]);
    const audioBytes = new TextEncoder().encode("OggS\0OpusHead");
    const seen: { routedInput?: unknown } = {};

    await processDiscordMessage(message as never, {
      botUserId: "bot-1",
      conversation: {} as never,
      commandContext: {
        getSurfaceListeningMode() {
          return "open";
        },
        getSurfaceThreadId() {
          return "thread-1";
        },
      } as never,
      approvalPolicy: "on-request",
      async fetchAudio() {
        return new Response(audioBytes, { headers: { "content-type": "audio/ogg" } });
      },
      async executeRouting(_context, input) {
        seen.routedInput = input.input;
        return { type: "submit", threadId: "thread-1", turnId: "turn-1" } as const;
      },
    });

    expect(seen.routedInput).toEqual([
      { type: "audio", url: `data:audio/ogg;base64,${Buffer.from(audioBytes).toString("base64")}` },
    ]);
    expect(reactions).toEqual(["🎙️"]);
  });

  test("preserves text, audio, and image attachment order", async () => {
    const { message } = makeMessage("<@bot-1> inspect these", true, [
      { url: "https://cdn.discordapp.com/note.ogg", contentType: "audio/ogg", name: "note.ogg" },
      { url: "https://cdn.discordapp.com/image.png", contentType: "image/png", name: "image.png" },
    ]);
    const seen: { routedInput?: unknown } = {};
    const audioBytes = new TextEncoder().encode("OggS\0OpusHead");
    const imageBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);

    await processDiscordMessage(message as never, {
      botUserId: "bot-1",
      conversation: {} as never,
      commandContext: {} as never,
      approvalPolicy: "on-request",
      async fetchAudio() {
        return new Response(audioBytes, { headers: { "content-type": "audio/ogg" } });
      },
      async fetchImage() {
        return new Response(imageBytes, { headers: { "content-type": "image/png" } });
      },
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
        toTextUserInput("inspect these"),
        { type: "audio", url: `data:audio/ogg;base64,${Buffer.from(audioBytes).toString("base64")}` },
        { type: "image", url: `data:image/png;base64,${Buffer.from(imageBytes).toString("base64")}` },
      ],
    });
  });
});
