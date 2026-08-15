import { describe, expect, test } from "bun:test";

import { normalizeDiscordMarkdown } from "../server/adapters/discord/markdown_normalizer.js";

const options = { cwd: "/srv/shepherd", homePath: "/home/tester" };

describe("Discord Markdown normalization", () => {
  test("renders checkout-local file links as relative inline-code paths", () => {
    const markdown = "See [commands.ts](/srv/shepherd/server/adapters/discord/commands.ts:42).";

    expect(normalizeDiscordMarkdown(markdown, options)).toBe(
      "See `server/adapters/discord/commands.ts:42`.",
    );
  });

  test("removes agent-workspace prefixes from links to other thread workspaces", () => {
    const markdown = [
      "[commands.ts](/home/tester/.agent-workspaces/shepherd/thread-123/server/commands.ts:10)",
      "[test.ts](</home/tester/.agent-workspaces/shepherd/thread-123/tests/a test.ts:20:4>)",
    ].join(" and ");

    expect(normalizeDiscordMarkdown(markdown, options)).toBe(
      "`server/commands.ts:10` and `tests/a test.ts:20:4`",
    );
  });

  test("supports file URLs, URI encoding, home paths, and escaped parentheses", () => {
    const markdown = [
      "[report](file:///srv/shepherd/docs/My%20Report.md:7)",
      "[notes](</home/tester/Notes/Today.md:8>)",
      String.raw`[fixture](/srv/shepherd/tests/value\(old\).ts:9)`,
    ].join("\n");

    expect(normalizeDiscordMarkdown(markdown, options)).toBe([
      "`docs/My Report.md:7`",
      "`~/Notes/Today.md:8`",
      "`tests/value(old).ts:9`",
    ].join("\n"));
  });

  test("preserves web links, images, inline code, and fenced code verbatim", () => {
    const markdown = [
      "[OpenAI](https://openai.com)",
      "![diagram](/srv/shepherd/diagram.png)",
      "`[inline](/srv/shepherd/server/inline.ts:1)`",
      "```md",
      "[fenced](/srv/shepherd/server/fenced.ts:2)",
      "```",
      "~~~md",
      "[tilde fenced](/srv/shepherd/server/tilde.ts:3)",
      "~~~",
      "[outside](/srv/shepherd/server/outside.ts:4)",
    ].join("\n");

    expect(normalizeDiscordMarkdown(markdown, options)).toBe([
      "[OpenAI](https://openai.com)",
      "![diagram](/srv/shepherd/diagram.png)",
      "`[inline](/srv/shepherd/server/inline.ts:1)`",
      "```md",
      "[fenced](/srv/shepherd/server/fenced.ts:2)",
      "```",
      "~~~md",
      "[tilde fenced](/srv/shepherd/server/tilde.ts:3)",
      "~~~",
      "`server/outside.ts:4`",
    ].join("\n"));
  });

  test("uses a safe inline-code delimiter when a path contains backticks", () => {
    const markdown = "[odd](</srv/shepherd/docs/a%60b.md:5>)";

    expect(normalizeDiscordMarkdown(markdown, options)).toBe("`` docs/a`b.md:5 ``");
  });

  test("leaves malformed and non-local Markdown links unchanged", () => {
    const markdown = [
      "[anchor](#section)",
      "[relative](docs/guide.md)",
      "[broken](/srv/shepherd/%E0%A4%A.md:2)",
    ].join("\n");

    expect(normalizeDiscordMarkdown(markdown, options)).toBe([
      "[anchor](#section)",
      "[relative](docs/guide.md)",
      "`%E0%A4%A.md:2`",
    ].join("\n"));
  });
});
