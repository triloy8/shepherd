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
          path: "/home/tadhiel/shepherd/.agents/skills/github/SKILL.md",
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
      path: "/home/tadhiel/shepherd/.agents/skills/github/SKILL.md",
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
              path: "/home/tadhiel/shepherd/.agents/skills/github/SKILL.md",
              description: "",
              enabled: true,
            },
            {
              name: "github",
              scope: "user",
              path: "/home/tadhiel/.agents/skills/github/SKILL.md",
              description: "",
              enabled: true,
            },
          ],
        },
      ],
    };

    expect(resolveSkillPathFromList(ambiguous, "github")).toEqual({
      error: { code: "skill_ambiguous", requestedSkill: "github", candidates: ambiguous.data[0].skills.map(({ name, scope, path }) => ({ name, scope, path })) },
    });
  });

  test("resolves a qualified skill name", () => {
    expect(resolveSkillPathFromList(listed, "github [workspace]")).toEqual({
      path: "/home/tadhiel/shepherd/.agents/skills/github/SKILL.md",
    });
  });

  test("returns a clear error when no skill matches", () => {
    expect(resolveSkillPathFromList(listed, "missing")).toEqual({
      error: { code: "skill_not_found", requestedSkill: "missing" },
    });
  });
});
