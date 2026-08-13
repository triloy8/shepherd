import { describe, expect, test } from "bun:test";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  MessageFlags,
} from "discord.js";

import {
  buildCardPages,
  buildProgressPages,
} from "../server/adapters/discord/components_renderer.js";
import {
  chunkForDiscord,
  createDiscordEditableSurfaceState,
  createDiscordPreviewState,
  sendDiscordMarkdown,
  sendDiscordPages,
  updateDiscordEditableSurfaces,
  updateDiscordPreview,
} from "../server/adapters/discord/stream_delivery.js";
import { discordTextLength } from "../server/adapters/discord/chunking.js";

type HarnessOptions = {
  failSendAt?: number;
  failFetch?: boolean;
  rejectV2?: boolean;
};

function createChannelHarness(options: HarnessOptions = {}) {
  const attempts: unknown[] = [];
  const sent: unknown[] = [];
  const edits: Array<{ id: string; payload: unknown }> = [];
  const messages = new Map<string, { id: string; edit: (payload: unknown) => Promise<void> }>();

  const channel = {
    async send(payload: unknown) {
      attempts.push(payload);
      if (options.failSendAt === sent.length + 1) throw new Error("send failed");
      if (
        options.rejectV2 &&
        payload &&
        typeof payload === "object" &&
        (payload as { flags?: unknown }).flags === MessageFlags.IsComponentsV2
      ) {
        throw Object.assign(new Error("Invalid Form Body: IS_COMPONENTS_V2"), { code: 50_035 });
      }
      sent.push(payload);
      const id = `msg-${sent.length}`;
      const message = {
        id,
        async edit(next: unknown) {
          edits.push({ id, payload: next });
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

  return { channel: channel as never, attempts, sent, edits, messages };
}

function componentJson(component: unknown): Record<string, unknown> {
  return (component && typeof component === "object" && "toJSON" in component
    ? (component as { toJSON: () => unknown }).toJSON()
    : component) as Record<string, unknown>;
}

function textDisplayContent(payload: unknown): string {
  if (!payload || typeof payload !== "object") return String(payload);
  const components = (payload as { components?: unknown[] }).components ?? [];
  const first = componentJson(components[0]);
  if (first.type === ComponentType.TextDisplay) return String(first.content);
  const children = (first.components as unknown[] | undefined) ?? [];
  return children
    .map(componentJson)
    .filter((child) => child.type === ComponentType.TextDisplay)
    .map((child) => String(child.content))
    .join("\n");
}

describe("Discord markdown segmentation", () => {
  test("prefers whitespace boundaries", () => {
    expect(chunkForDiscord("alpha beta gamma", { maxChars: 10, includePageIndicators: false }))
      .toEqual(["alpha beta", " gamma"]);
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

  test("avoids breaking inline code and Unicode", () => {
    const inline = chunkForDiscord("alpha `inline code` omega delta", {
      maxChars: 20,
      includePageIndicators: false,
    });
    expect(inline.every((chunk) => ((chunk.match(/(?<!\\)`/g)?.length ?? 0) % 2) === 0)).toBe(true);

    const emoji = chunkForDiscord("😀".repeat(20), { maxChars: 7, includePageIndicators: false });
    expect(emoji.join("")).toBe("😀".repeat(20));
    expect(emoji.every((chunk) => discordTextLength(chunk) <= 7 && !chunk.includes("�"))).toBe(true);
  });
});

describe("Discord Components V2 delivery", () => {
  test("sends markdown as mention-safe Text Displays", async () => {
    const { channel, sent } = createChannelHarness();
    const result = await sendDiscordMarkdown(channel, "# Result\n\nDone.", {
      replyToMessageId: "user-1",
    });

    expect(result.success).toBe(true);
    expect((sent[0] as { flags?: unknown }).flags).toBe(MessageFlags.IsComponentsV2);
    expect(textDisplayContent(sent[0])).toBe("# Result\n\nDone.");
    expect((sent[0] as { allowedMentions?: unknown }).allowedMentions).toEqual({
      parse: [],
      repliedUser: false,
    });
  });

  test("reports a Components V2 rejection without downgrading", async () => {
    const { channel, attempts, sent } = createChannelHarness({ rejectV2: true });
    const result = await sendDiscordMarkdown(channel, "V2 only");

    expect(result.success).toBe(false);
    expect(result.error).toBe("Invalid Form Body: IS_COMPONENTS_V2");
    expect(attempts).toHaveLength(1);
    expect((attempts[0] as { flags?: unknown }).flags).toBe(MessageFlags.IsComponentsV2);
    expect((attempts[0] as { content?: unknown }).content).toBeUndefined();
    expect(sent).toHaveLength(0);
  });

  test("does not retry a rejected V2 card as legacy content", async () => {
    const { channel, attempts, sent } = createChannelHarness({ rejectV2: true });
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("approve").setLabel("Approve").setStyle(ButtonStyle.Success),
    );
    const result = await sendDiscordPages(
      channel,
      buildCardPages({ title: "Approval", text: "Proceed?", actionRows: [row] }),
      { replyToMessageId: "user-1" },
    );

    expect(result.success).toBe(false);
    expect(attempts).toHaveLength(1);
    expect((attempts[0] as { content?: unknown }).content).toBeUndefined();
    expect((attempts[0] as { reply?: unknown }).reply).toEqual({
      messageReference: "user-1",
      failIfNotExists: false,
    });
    expect(sent).toHaveLength(0);
  });

  test("reports a partial continuation failure", async () => {
    const { channel, sent } = createChannelHarness({ failSendAt: 2 });
    const result = await sendDiscordMarkdown(channel, "x".repeat(5_000));

    expect(result.success).toBe(false);
    expect(result.partial).toBe(true);
    expect(result.deliveredChunks).toBe(1);
    expect(result.totalChunks).toBe(2);
    expect(sent).toHaveLength(1);
  });

  test("updates editable Container progress without changing message mode", async () => {
    const { channel, sent, edits } = createChannelHarness();
    const state = createDiscordEditableSurfaceState();
    await updateDiscordEditableSurfaces(channel, state, buildProgressPages("one"));
    await updateDiscordEditableSurfaces(channel, state, buildProgressPages("one\ntwo"));

    expect(sent).toHaveLength(1);
    expect(edits).toHaveLength(1);
    expect((edits[0]?.payload as { flags?: unknown }).flags).toBe(MessageFlags.IsComponentsV2);
    expect(textDisplayContent(edits[0]?.payload)).toContain("one\ntwo");
  });

  test("leaves rejected V2 progress surfaces undelivered", async () => {
    const { channel, attempts, sent, edits } = createChannelHarness({ rejectV2: true });
    const state = createDiscordEditableSurfaceState();
    const first = await updateDiscordEditableSurfaces(channel, state, buildProgressPages("one"));
    const second = await updateDiscordEditableSurfaces(channel, state, buildProgressPages("one\ntwo"));

    expect(first.success).toBe(false);
    expect(second.success).toBe(false);
    expect(attempts).toHaveLength(2);
    expect(sent).toHaveLength(0);
    expect(edits).toHaveLength(0);
  });
});

describe("Discord optional Components V2 preview", () => {
  test("edits the first Text Display and sends continuations on finalization", async () => {
    const { channel, sent, edits } = createChannelHarness();
    const state = createDiscordPreviewState();
    await updateDiscordPreview(channel, state, "preview");
    const result = await updateDiscordPreview(channel, state, `${"z".repeat(5_000)}END`, {
      finalize: true,
    });

    expect(result.success).toBe(true);
    expect(sent).toHaveLength(3);
    expect(edits).toHaveLength(1);
    expect([
      textDisplayContent(edits[0]?.payload),
      ...sent.slice(1).map(textDisplayContent),
    ].join(""))
      .toContain("END");
  });
});
