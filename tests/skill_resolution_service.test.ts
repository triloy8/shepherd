import { describe, expect, test } from "bun:test";

import { resolveSkillPathFromList } from "../server/core/skill_resolution_service.js";

const listed = {
  data: [
    {
      cwd: "/home/tadhiel/shepherd",
      errors: [],
      skills: [
        {
          name: "github",
          scope: "workspace",
          path: "/home/tadhiel/shepherd/.codex/skills/github/SKILL.md",
          description: "",
          enabled: true,
        },
      ],
    },
  ],
};

describe("SkillResolutionService", () => {
  test("passes through explicit paths", () => {
    expect(resolveSkillPathFromList(listed, "/tmp/skill.md")).toEqual({ path: "/tmp/skill.md" });
  });

  test("resolves a unique skill name", () => {
    expect(resolveSkillPathFromList(listed, "github")).toEqual({
      path: "/home/tadhiel/shepherd/.codex/skills/github/SKILL.md",
    });
  });

  test("returns a clear error for ambiguous names", () => {
    const ambiguous = {
      data: [
        {
          cwd: "/home/tadhiel/shepherd",
          errors: [],
          skills: [
            {
              name: "github",
              scope: "workspace",
              path: "/home/tadhiel/shepherd/.codex/skills/github/SKILL.md",
              description: "",
              enabled: true,
            },
            {
              name: "github",
              scope: "user",
              path: "/home/tadhiel/.codex/skills/github/SKILL.md",
              description: "",
              enabled: true,
            },
          ],
        },
      ],
    };

    expect(resolveSkillPathFromList(ambiguous, "github")).toEqual({
      error: "Multiple skills match `github`: github [workspace], github [user]. Use the full path.",
    });
  });

  test("resolves a qualified skill name", () => {
    expect(resolveSkillPathFromList(listed, "github [workspace]")).toEqual({
      path: "/home/tadhiel/shepherd/.codex/skills/github/SKILL.md",
    });
  });

  test("returns a clear error when no skill matches", () => {
    expect(resolveSkillPathFromList(listed, "missing")).toEqual({
      error: "No loaded skill matches `missing`. Use `!skills` to inspect available names.",
    });
  });
});
