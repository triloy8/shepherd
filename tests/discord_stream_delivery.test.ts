import { describe, expect, test } from "bun:test";

import {
  chunkForDiscord,
  createDiscordStreamState,
  flushDiscordStream,
} from "../server/adapters/discord/stream_delivery.js";
import { createResponseStreamState } from "../server/core/response_stream_reducer.js";

describe("Discord stream delivery", () => {
  test("chunks text on whitespace boundaries when possible", () => {
    expect(chunkForDiscord("alpha beta gamma", 10)).toEqual(["alpha beta", " gamma"]);
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
