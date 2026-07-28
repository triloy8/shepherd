import { describe, expect, test } from "bun:test";

import {
  chunkForDiscord,
  createDiscordEditableChunksState,
  createDiscordPreviewState,
  sendDiscordText,
  updateDiscordEditableChunks,
  updateDiscordPreview,
} from "../server/adapters/discord/stream_delivery.js";
import { discordTextLength } from "../server/adapters/discord/chunking.js";

type HarnessOptions = {
  failSendAt?: number;
  failFetch?: boolean;
};

function createChannelHarness(options: HarnessOptions = {}) {
  const sent: string[] = [];
  const edits: Array<{ id: string; content: string }> = [];
  const messages = new Map<string, { id: string; edit: (content: string) => Promise<void> }>();

  const channel = {
    async send(content: string | { content: string }) {
      const text = typeof content === "string" ? content : content.content;
      if (options.failSendAt === sent.length + 1) throw new Error("send failed");
      sent.push(text);
      const id = `msg-${sent.length}`;
      const message = {
        id,
        async edit(next: string) {
          edits.push({ id, content: next });
        },
      };
      messages.set(id, message);
      return message;
    },
    messages: {
      async fetch(id: string) {
        if (options.failFetch) throw new Error("fetch failed");
        const message = messages.get(id);
        if (!message) throw new Error(`unknown message ${id}`);
        return message;
      },
    },
  };

  return { channel: channel as never, sent, edits, messages };
}

describe("Discord final chunking", () => {
  test("prefers whitespace boundaries", () => {
    expect(
      chunkForDiscord("alpha beta gamma", {
        maxChars: 10,
        includePageIndicators: false,
      }),
    ).toEqual(["alpha beta", " gamma"]);
  });

  test("balances backtick and tilde fences across chunks", () => {
    for (const marker of ["```", "~~~"]) {
      const chunks = chunkForDiscord(
        `${marker}ts\nconst value = 1;\nconst other = 2;\n${marker}`,
        { maxChars: 24, includePageIndicators: false },
      );
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(discordTextLength(chunk)).toBeLessThanOrEqual(24);
        expect(chunk.startsWith(`${marker}ts\n`)).toBe(true);
        expect(chunk.endsWith(`\n${marker}`)).toBe(true);
      }
    }
  });

  test("does not split tall content merely because it has many lines", () => {
    const text = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n");
    expect(chunkForDiscord(text)).toEqual([text]);
  });

  test("avoids breaking a short inline-code span", () => {
    const chunks = chunkForDiscord("alpha `inline code` omega delta", {
      maxChars: 20,
      includePageIndicators: false,
    });
    for (const chunk of chunks) {
      expect((chunk.match(/(?<!\\)`/g)?.length ?? 0) % 2).toBe(0);
    }
  });

  test("splits Unicode on code-point boundaries", () => {
    const text = "😀".repeat(20);
    const chunks = chunkForDiscord(text, {
      maxChars: 7,
      includePageIndicators: false,
    });
    expect(chunks.join("")).toBe(text);
    expect(chunks.every((chunk) => discordTextLength(chunk) <= 7)).toBe(true);
    expect(chunks.every((chunk) => !chunk.includes("�"))).toBe(true);
  });

  test("adds stable page indicators without exceeding the configured limit", () => {
    const chunks = chunkForDiscord("x".repeat(100), { maxChars: 30 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toStartWith("(1/");
    expect(chunks.at(-1)).toStartWith(`(${chunks.length}/${chunks.length})`);
    expect(chunks.every((chunk) => discordTextLength(chunk) <= 30)).toBe(true);
  });
});

describe("Discord completed delivery", () => {
  test("reports a partial continuation failure", async () => {
    const { channel, sent } = createChannelHarness({ failSendAt: 2 });
    const result = await sendDiscordText(channel, "x".repeat(5_000));

    expect(result.success).toBe(false);
    expect(result.partial).toBe(true);
    expect(result.deliveredChunks).toBe(1);
    expect(result.totalChunks).toBeGreaterThan(1);
    expect(sent).toHaveLength(1);
  });

  test("updates accumulated progress bubbles and replaces an uneditable bubble", async () => {
    const first = createChannelHarness();
    const state = createDiscordEditableChunksState();
    await updateDiscordEditableChunks(first.channel, state, "one");
    expect(state.messageIds).toEqual(["msg-1"]);

    const replacement = createChannelHarness({ failFetch: true });
    await updateDiscordEditableChunks(replacement.channel, state, "one\ntwo");
    expect(replacement.sent).toEqual(["one\ntwo"]);
    expect(state.messageIds).toEqual(["msg-1"]);
  });

  test("rolls accumulated progress into additional editable bubbles", async () => {
    const { channel, sent } = createChannelHarness();
    const state = createDiscordEditableChunksState();
    const result = await updateDiscordEditableChunks(channel, state, "activity\n".repeat(500));

    expect(result.success).toBe(true);
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.every((chunk) => discordTextLength(chunk) <= 1_900)).toBe(true);
    expect(state.messageIds).toHaveLength(sent.length);
  });
});

describe("Discord optional preview streaming", () => {
  test("keeps oversized midstream content in one saturated preview", async () => {
    const { channel, sent, edits } = createChannelHarness();
    const state = createDiscordPreviewState();

    await updateDiscordPreview(channel, state, "x".repeat(5_000));
    await updateDiscordPreview(channel, state, "x".repeat(5_500));

    expect(sent).toHaveLength(1);
    expect(edits).toHaveLength(0);
    expect(state.saturatedText).not.toBeNull();
  });

  test("clears saturation after content shrinks", async () => {
    const { channel, edits } = createChannelHarness();
    const state = createDiscordPreviewState();

    await updateDiscordPreview(channel, state, "x".repeat(5_000));
    await updateDiscordPreview(channel, state, "short");
    await updateDiscordPreview(channel, state, "x".repeat(5_000));

    expect(edits.map((edit) => edit.content)).toHaveLength(2);
    expect(edits[0]?.content).toBe("short");
  });

  test("finalization edits chunk one and sends every continuation", async () => {
    const { channel, sent, edits } = createChannelHarness();
    const state = createDiscordPreviewState();
    const finalText = `${"z".repeat(5_000)}END_MARKER_XYZ`;

    await updateDiscordPreview(channel, state, "z".repeat(2_500));
    const result = await updateDiscordPreview(channel, state, finalText, { finalize: true });

    expect(result.success).toBe(true);
    expect(edits).toHaveLength(1);
    expect(result.messageIds).toHaveLength(result.totalChunks);
    expect([...edits.map((edit) => edit.content), ...sent.slice(1)].join("")).toContain("END_MARKER_XYZ");
    expect(state.continuationMessageIds).toHaveLength(result.totalChunks - 1);
  });
});
