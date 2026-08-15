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
  buildMarkdownPages,
  componentsV2Payload,
  DISCORD_TEXT_DISPLAY_LIMIT,
  SURFACE_COLORS,
} from "../server/adapters/discord/components_renderer.js";

function jsonComponent(component: unknown): Record<string, unknown> {
  const value = component && typeof component === "object" && "toJSON" in component
    ? (component as { toJSON: () => unknown }).toJSON()
    : component;
  return value as Record<string, unknown>;
}

describe("Discord Components V2 rendering", () => {
  test("renders completed markdown as bare Text Displays", () => {
    const pages = buildMarkdownPages("# Result\n\n- one\n- two");
    const component = jsonComponent(pages[0]?.components[0]);
    const payload = componentsV2Payload(pages[0]!);

    expect(payload.flags).toBe(MessageFlags.IsComponentsV2);
    expect(payload.embeds).toBeUndefined();
    expect(payload.content).toBeUndefined();
    expect(component.type).toBe(ComponentType.TextDisplay);
    expect(component.content).toBe("# Result\n\n- one\n- two");
    expect(payload.allowedMentions).toEqual({ parse: [] });
  });

  test("normalizes local file links before rendering and leaves web links clickable", () => {
    const localPath = `${process.cwd()}/server/adapters/discord/components_renderer.ts:42`;
    const pages = buildMarkdownPages(
      `See [renderer.ts](${localPath}) and [the docs](https://developers.openai.com/codex).`,
    );
    const component = jsonComponent(pages[0]?.components[0]);

    expect(component.content).toBe(
      "See `server/adapters/discord/components_renderer.ts:42` and "
      + "[the docs](https://developers.openai.com/codex).",
    );
  });

  test("splits long markdown on balanced code-fence boundaries", () => {
    const pages = buildMarkdownPages(`\`\`\`ts\n${"const value = 1;\n".repeat(300)}\`\`\``);

    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      const component = jsonComponent(page.components[0]);
      const content = String(component.content);
      expect(Array.from(content).length).toBeLessThanOrEqual(DISCORD_TEXT_DISPLAY_LIMIT);
      expect(content.startsWith("```ts\n")).toBe(true);
      expect(content.endsWith("\n```")).toBe(true);
    }
  });

  test("renders structured state as paginated accented Containers", () => {
    const pages = buildCardPages({
      title: "Models",
      text: Array.from({ length: 400 }, (_, index) => `${index + 1}. model-${index}`).join("\n"),
      tone: "success",
    });

    expect(pages.length).toBeGreaterThan(1);
    for (const [index, page] of pages.entries()) {
      const container = jsonComponent(page.components[0]);
      const children = container.components as unknown[];
      expect(container.type).toBe(ComponentType.Container);
      expect(container.accent_color).toBe(SURFACE_COLORS.success);
      expect(jsonComponent(children[0]).content).toBe(`## Models (${index + 1}/${pages.length})`);
    }
  });

  test("nests action rows inside Components V2 Containers", () => {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("approve").setLabel("Approve").setStyle(ButtonStyle.Success),
    );
    const page = buildCardPages({ title: "Approval", text: "Proceed?", actionRows: [row] })[0]!;
    const container = jsonComponent(page.components[0]);
    const children = container.components as unknown[];

    expect(jsonComponent(children.at(-1)).type).toBe(ComponentType.ActionRow);
  });
});
