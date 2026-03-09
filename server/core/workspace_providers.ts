import path from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { WorkspaceTarget } from "../../shared/protocol/requests.js";
import type { MaterializedWorkspace, WorkspaceProvider } from "./workspace_service.js";

const execFileAsync = promisify(execFile);

type RunCommand = (args: string[]) => Promise<string>;

function repoNameFromSlug(slug: string): string {
  return slug.split("/")[1] ?? slug;
}

async function runGh(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("gh", args, {
      cwd: process.cwd(),
      env: process.env,
      maxBuffer: 1024 * 1024 * 10,
    });
    return stdout.trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`gh ${args.join(" ")} failed: ${message}`);
  }
}

export class GitHubWorkspaceProvider implements WorkspaceProvider<Extract<WorkspaceTarget, { kind: "github" }>> {
  readonly kind = "github" as const;

  constructor(private readonly runCommand: RunCommand = runGh) {}

  async materialize(
    target: Extract<WorkspaceTarget, { kind: "github" }>,
  ): Promise<MaterializedWorkspace> {
    const workspaceId = randomUUID();
    const repoName = repoNameFromSlug(target.repoSlug);
    const workspacePath = path.join(homedir(), ".agent-workspaces", repoName, workspaceId);
    const marker = path.join(workspacePath, ".git");
    try {
      await fs.stat(marker);
    } catch {
      await fs.mkdir(path.dirname(workspacePath), { recursive: true });
      await this.runCommand(["repo", "clone", target.repoSlug, workspacePath, "--", "--recurse-submodules"]);
    }
    return { workspaceId, cwd: workspacePath, target };
  }
}

export class LocalWorkspaceProvider implements WorkspaceProvider<Extract<WorkspaceTarget, { kind: "local" }>> {
  readonly kind = "local" as const;

  async materialize(
    target: Extract<WorkspaceTarget, { kind: "local" }>,
  ): Promise<MaterializedWorkspace> {
    const workspaceId = randomUUID();
    const cwd = target.appendWorkspaceId ? path.join(target.rootPath, workspaceId) : target.rootPath;
    await fs.mkdir(cwd, { recursive: true });
    return { workspaceId, cwd, target };
  }
}
