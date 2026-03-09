import path from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type {
  WorkspaceTarget,
  CreateThreadRequest,
  ForkThreadRequest,
  ResumeThreadRequest,
} from "../../shared/protocol/requests.js";

const execFileAsync = promisify(execFile);

function toSurfaceKey(adapter: string, surfaceId: string): string {
  return `${adapter}:${surfaceId}`;
}

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

export type MaterializedWorkspace = {
  workspaceId: string;
  cwd: string;
  target: WorkspaceTarget;
};

export class WorkspaceService {
  private readonly targetsBySurface = new Map<string, WorkspaceTarget>();

  getSurfaceTarget(adapter: string, surfaceId: string): WorkspaceTarget | null {
    return this.targetsBySurface.get(toSurfaceKey(adapter, surfaceId)) ?? null;
  }

  setSurfaceTarget(adapter: string, surfaceId: string, target: WorkspaceTarget): void {
    this.targetsBySurface.set(toSurfaceKey(adapter, surfaceId), target);
  }

  clearSurfaceTarget(adapter: string, surfaceId: string): void {
    this.targetsBySurface.delete(toSurfaceKey(adapter, surfaceId));
  }

  async materializeSurfaceWorkspace(adapter: string, surfaceId: string): Promise<MaterializedWorkspace> {
    const target = this.getSurfaceTarget(adapter, surfaceId);
    if (!target) {
      throw new Error("No workspace target configured for this surface.");
    }
    return this.materializeTarget(target);
  }

  async materializeTarget(target: WorkspaceTarget): Promise<MaterializedWorkspace> {
    const workspaceId = randomUUID();
    if (target.kind === "github") {
      const repoName = repoNameFromSlug(target.repoSlug);
      const workspacePath = path.join(homedir(), ".agent-workspaces", repoName, workspaceId);
      const marker = path.join(workspacePath, ".git");
      try {
        await fs.stat(marker);
      } catch {
        await fs.mkdir(path.dirname(workspacePath), { recursive: true });
        await runGh(["repo", "clone", target.repoSlug, workspacePath, "--", "--recurse-submodules"]);
      }
      return { workspaceId, cwd: workspacePath, target };
    }

    const cwd = target.appendWorkspaceId ? path.join(target.rootPath, workspaceId) : target.rootPath;
    await fs.mkdir(cwd, { recursive: true });
    return { workspaceId, cwd, target };
  }

  applyCwdToCreateRequest(request: Omit<CreateThreadRequest, "cwd">, cwd: string): CreateThreadRequest {
    return { ...request, cwd };
  }

  applyCwdToResumeRequest(request: Omit<ResumeThreadRequest, "cwd">, cwd: string): ResumeThreadRequest {
    return { ...request, cwd };
  }

  applyCwdToForkRequest(request: Omit<ForkThreadRequest, "cwd">, cwd: string): ForkThreadRequest {
    return { ...request, cwd };
  }
}
