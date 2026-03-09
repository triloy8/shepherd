import { describe, expect, test } from "bun:test";

import { WorkspaceService } from "../server/core/workspace_service.js";
import { GitHubWorkspaceProvider, LocalWorkspaceProvider } from "../server/core/workspace_providers.js";

describe("WorkspaceService providers", () => {
  test("materializeSurfaceWorkspace dispatches to the matching provider", async () => {
    const calls: unknown[] = [];
    const service = new WorkspaceService([
      {
        kind: "local",
        async materialize(target) {
          calls.push(target);
          return {
            workspaceId: "workspace-1",
            cwd: "/tmp/workspace-1",
            target,
          };
        },
      },
    ]);

    service.setSurfaceTarget("http", "surface-1", {
      kind: "local",
      rootPath: "/tmp",
      display: "~/tmp",
      appendWorkspaceId: true,
    });

    const result = await service.materializeSurfaceWorkspace("http", "surface-1");

    expect(result).toEqual({
      workspaceId: "workspace-1",
      cwd: "/tmp/workspace-1",
      target: {
        kind: "local",
        rootPath: "/tmp",
        display: "~/tmp",
        appendWorkspaceId: true,
      },
    });
    expect(calls).toEqual([
      {
        kind: "local",
        rootPath: "/tmp",
        display: "~/tmp",
        appendWorkspaceId: true,
      },
    ]);
  });

  test("materializeTarget fails cleanly when no provider exists", async () => {
    const service = new WorkspaceService();

    await expect(
      service.materializeTarget({
        kind: "local",
        rootPath: "/tmp",
        display: "~/tmp",
        appendWorkspaceId: true,
      }),
    ).rejects.toThrow("No workspace provider registered for target kind local.");
  });
});

describe("Workspace providers", () => {
  test("LocalWorkspaceProvider reuses the root path when appendWorkspaceId=false", async () => {
    const provider = new LocalWorkspaceProvider();
    const result = await provider.materialize({
      kind: "local",
      rootPath: "/tmp/shepherd-workspace-provider",
      display: "~/tmp/shepherd-workspace-provider",
      appendWorkspaceId: false,
    });

    expect(result.cwd).toBe("/tmp/shepherd-workspace-provider");
    expect(result.target.kind).toBe("local");
  });

  test("GitHubWorkspaceProvider shells out through its injected runner", async () => {
    const calls: string[][] = [];
    const provider = new GitHubWorkspaceProvider(async (args) => {
      calls.push(args);
      return "";
    });

    const result = await provider.materialize({
      kind: "github",
      repoSlug: "triloy8/shepherd",
      display: "triloy8/shepherd",
    });

    expect(result.target).toEqual({
      kind: "github",
      repoSlug: "triloy8/shepherd",
      display: "triloy8/shepherd",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 3)).toEqual(["repo", "clone", "triloy8/shepherd"]);
  });
});
