import { describe, expect, test } from "bun:test";

import {
  describeProjectTarget,
  resolveProjectTarget,
} from "../server/core/project_target_service.js";

describe("ProjectTargetService", () => {
  test("resolves ~ to the default local workspace root", async () => {
    const target = await resolveProjectTarget("~");

    expect(target).toEqual({
      kind: "local",
      rootPath: "/home/tadhiel/.agent-workspaces/local",
      display: "~",
      appendWorkspaceId: true,
    });
    expect(describeProjectTarget(target)).toBe("~");
  });

  test("resolves ~/path to a local project target", async () => {
    const target = await resolveProjectTarget("~/repo");

    expect(target).toEqual({
      kind: "local",
      rootPath: "/home/tadhiel/repo",
      display: "~/repo",
      appendWorkspaceId: false,
    });
  });

  test("resolves github repo targets through the injected resolver", async () => {
    const target = await resolveProjectTarget("owner/repo", {
      async resolveGithubRepo(slug) {
        expect(slug).toBe("owner/repo");
        return "Owner/repo";
      },
    });

    expect(target).toEqual({
      kind: "github",
      slug: "Owner/repo",
      display: "Owner/repo",
    });
  });

  test("rejects invalid repo targets", async () => {
    await expect(resolveProjectTarget("not a repo")).rejects.toThrow(
      "Invalid repo target. Use `<owner>/<repo>`, `~`, or `~/path`.",
    );
  });

  test("rejects github targets that do not resolve to the requested repo", async () => {
    await expect(
      resolveProjectTarget("owner/repo", {
        async resolveGithubRepo() {
          return "other/repo";
        },
      }),
    ).rejects.toThrow("Unable to resolve repo owner/repo.");
  });
});
