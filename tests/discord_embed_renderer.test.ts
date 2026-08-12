import { describe, expect, test } from "bun:test";

import {
  buildDescriptionPages,
  buildEmbed,
  DISCORD_EMBED_LIMITS,
} from "../server/adapters/discord/embed_renderer.js";

function embedTextLength(embed: {
  title?: string;
  description?: string;
  fields?: Array<{ name: string; value: string }>;
  footer?: { text: string };
}): number {
  return [
    embed.title ?? "",
    embed.description ?? "",
    ...(embed.fields ?? []).flatMap((field) => [field.name, field.value]),
    embed.footer?.text ?? "",
  ].reduce((total, value) => total + Array.from(value).length, 0);
}

describe("Discord embed rendering", () => {
  test("enforces individual and combined Discord limits", () => {
    const embed = buildEmbed({
      title: "t".repeat(500),
      description: "d".repeat(5_000),
      fields: Array.from({ length: 30 }, (_, index) => ({
        name: `field-${index}-${"n".repeat(300)}`,
        value: "v".repeat(2_000),
      })),
      footer: "f".repeat(3_000),
    });

    expect(Array.from(embed.title ?? "")).toHaveLength(DISCORD_EMBED_LIMITS.title);
    expect(Array.from(embed.description ?? "").length).toBeLessThanOrEqual(
      DISCORD_EMBED_LIMITS.description,
    );
    expect(embed.fields?.length ?? 0).toBeLessThanOrEqual(DISCORD_EMBED_LIMITS.fields);
    expect(
      (embed.fields ?? []).every(
        (field) =>
          Array.from(field.name).length <= DISCORD_EMBED_LIMITS.fieldName &&
          Array.from(field.value).length <= DISCORD_EMBED_LIMITS.fieldValue,
      ),
    ).toBe(true);
    expect(embedTextLength(embed)).toBeLessThanOrEqual(DISCORD_EMBED_LIMITS.total);
  });

  test("paginates long descriptions with stable page labels", () => {
    const pages = buildDescriptionPages({
      title: "Models",
      text: Array.from({ length: 300 }, (_, index) => `${index + 1}. model-${index}`).join("\n"),
      footer: "Available models",
    });

    expect(pages.length).toBeGreaterThan(1);
    expect(pages[0]?.footer?.text).toContain(`Page 1/${pages.length}`);
    expect(pages.at(-1)?.footer?.text).toContain(`Page ${pages.length}/${pages.length}`);
    expect(pages.every((page) => embedTextLength(page) <= DISCORD_EMBED_LIMITS.total)).toBe(true);
  });
});
