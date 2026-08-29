import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("GitHub skill policy", () => {
  test("loads only the Shepherd-owned policy", () => {
    const skill = readFileSync(".codex/skills/github/SKILL.md", "utf8");

    expect(skill).toContain("${SHEPHERD_CONFIG_DIR:");
    expect(skill).toContain("/skills/github/local.env");
    expect(skill).toContain("Never create or source `.codex/skills/github/local.env`");
    expect(skill).not.toContain("source .codex/skills/github/local.env");
  });
});
