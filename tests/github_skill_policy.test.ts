import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("GitHub skill policy", () => {
  test("loads only the Shepherd-owned policy", () => {
    const skill = readFileSync(".agents/skills/github/SKILL.md", "utf8");

    expect(skill).toContain("${SHEPHERD_SKILLS_DIR:-$HOME/shepherd/.agents/skills}");
    expect(skill).toContain("$shepherd_skills_dir/github/local.env");
    expect(skill).toContain("Never create or source `.agents/skills/github/local.env`");
    expect(skill).not.toContain("source .agents/skills/github/local.env");
  });
});
