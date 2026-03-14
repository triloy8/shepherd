import { describe, expect, test } from "bun:test";

import {
  chunkForDiscord,
  createDiscordStreamState,
  flushDiscordStream,
} from "../server/adapters/discord/stream_delivery.js";
import { DISCORD_STREAM_SOFT_LINE_LIMIT } from "../server/adapters/discord/chunking.js";
import { createResponseStreamState } from "../server/core/response_stream_reducer.js";

describe("Discord stream delivery", () => {
  test("chunks text on whitespace boundaries when possible", () => {
    expect(chunkForDiscord("alpha beta gamma", 10)).toEqual(["alpha beta", " gamma"]);
  });

  test("keeps fenced code blocks balanced across chunks", () => {
    const chunks = chunkForDiscord("```ts\nconst value = 1;\nconst other = 2;\n```", 20);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(20);
      expect(chunk.startsWith("```ts\n")).toBe(true);
      expect(chunk.endsWith("\n```")).toBe(true);
      expect(chunk.match(/```/g)?.length ?? 0).toBe(2);
    }
  });

  test("splits tall messages on soft line boundaries", () => {
    const text = Array.from({ length: DISCORD_STREAM_SOFT_LINE_LIMIT + 2 }, (_, index) => `line ${index + 1}`).join("\n");
    const chunks = chunkForDiscord(text);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.split("\n")).toHaveLength(DISCORD_STREAM_SOFT_LINE_LIMIT);
    expect(chunks[1]?.split("\n")).toHaveLength(2);
  });

  test("splits long unbroken lines at the limit", () => {
    const chunks = chunkForDiscord("x".repeat(25), 10);

    expect(chunks).toEqual(["xxxxxxxxxx", "xxxxxxxxxx", "xxxxx"]);
  });

  test("sends new chunks and records message ids", async () => {
    const sent: string[] = [];
    const state = createDiscordStreamState({
      ...createResponseStreamState(),
      text: "first\nsecond",
    });

    const channel = {
      async send(content: string | { content: string }) {
        const text = typeof content === "string" ? content : content.content;
        sent.push(text);
        return { id: `msg-${sent.length}` };
      },
      messages: {
        async fetch() {
          throw new Error("unexpected fetch");
        },
      },
    };

    await flushDiscordStream(channel as never, state);

    expect(sent).toEqual(["first\nsecond"]);
    expect(state.messageIds).toEqual(["msg-1"]);
    expect(state.renderedChunks).toEqual(["first\nsecond"]);
  });

  test("edits existing messages when chunk content changes", async () => {
    const edited: string[] = [];
    const state = createDiscordStreamState({
      ...createResponseStreamState(),
      text: "updated",
    });
    state.messageIds = ["msg-1"];
    state.renderedChunks = ["stale"];

    const channel = {
      async send() {
        throw new Error("unexpected send");
      },
      messages: {
        async fetch(id: string) {
          expect(id).toBe("msg-1");
          return {
            async edit(content: string) {
              edited.push(content);
            },
          };
        },
      },
    };

    await flushDiscordStream(channel as never, state);

    expect(edited).toEqual(["updated"]);
    expect(state.renderedChunks).toEqual(["updated"]);
  });
});
