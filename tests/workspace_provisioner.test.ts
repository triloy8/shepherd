import { describe, expect, test } from "bun:test";

import { WorkspaceProvisioner } from "../server/core/workspace_provisioner.js";

describe("WorkspaceProvisioner", () => {
  test("provisions github workspaces under the agent workspace root", async () => {
    const mkdirCalls: string[] = [];
    const cloneCalls: Array<{ slug: string; workspacePath: string }> = [];
    const provisioner = new WorkspaceProvisioner({
      homedirPath: "/home/tadhiel",
      fsImpl: {
        async stat() {
          throw new Error("missing");
        },
        async mkdir(path) {
          mkdirCalls.push(String(path));
        },
      } as never,
      async cloneGithubRepo(slug, workspacePath) {
        cloneCalls.push({ slug, workspacePath });
      },
    });

    const result = await provisioner.provisionWorkspace(
      { kind: "github", slug: "owner/repo", display: "owner/repo" },
      "ws-1",
    );

    expect(result).toEqual({
      workspaceId: "ws-1",
      cwd: "/home/tadhiel/.agent-workspaces/repo/ws-1",
    });
    expect(mkdirCalls).toEqual(["/home/tadhiel/.agent-workspaces/repo"]);
    expect(cloneCalls).toEqual([
      { slug: "owner/repo", workspacePath: "/home/tadhiel/.agent-workspaces/repo/ws-1" },
    ]);
  });

  test("provisions local workspaces by appending workspace id when configured", async () => {
    const mkdirCalls: string[] = [];
    const provisioner = new WorkspaceProvisioner({
      fsImpl: {
        async stat() {
          return {} as never;
        },
        async mkdir(path) {
          mkdirCalls.push(String(path));
        },
      } as never,
    });

    const result = await provisioner.provisionWorkspace(
      { kind: "local", rootPath: "/tmp/local", display: "~", appendWorkspaceId: true },
      "ws-2",
    );

    expect(result).toEqual({
      workspaceId: "ws-2",
      cwd: "/tmp/local/ws-2",
    });
    expect(mkdirCalls).toEqual(["/tmp/local/ws-2"]);
  });
});
