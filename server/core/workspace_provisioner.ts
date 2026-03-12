import path from "node:path";
import { homedir } from "node:os";
import { promises as fs } from "node:fs";

import type { ProjectTarget } from "./project_target_service.js";

type FileSystemLike = {
  stat: typeof fs.stat;
  mkdir: typeof fs.mkdir;
};

export type WorkspaceProvisionerOptions = {
  fsImpl?: FileSystemLike;
  cloneGithubRepo?: (slug: string, workspacePath: string) => Promise<void>;
  homedirPath?: string;
};

function repoNameFromSlug(slug: string): string {
  return slug.split("/")[1] ?? slug;
}

export class WorkspaceProvisioner {
  private readonly fsImpl: FileSystemLike;
  private readonly cloneGithubRepo: (slug: string, workspacePath: string) => Promise<void>;
  private readonly homedirPath: string;

  constructor(options: WorkspaceProvisionerOptions = {}) {
    this.fsImpl = options.fsImpl ?? fs;
    this.cloneGithubRepo =
      options.cloneGithubRepo ??
      (async () => {
        throw new Error("GitHub workspace cloning is not configured.");
      });
    this.homedirPath = options.homedirPath ?? homedir();
  }

  async provisionWorkspace(
    target: ProjectTarget,
    workspaceId: string,
  ): Promise<{ workspaceId: string; cwd: string }> {
    if (target.kind === "github") {
      const repoName = repoNameFromSlug(target.slug);
      const workspacePath = path.join(this.homedirPath, ".agent-workspaces", repoName, workspaceId);
      const marker = path.join(workspacePath, ".git");
      try {
        await this.fsImpl.stat(marker);
      } catch {
        await this.fsImpl.mkdir(path.dirname(workspacePath), { recursive: true });
        await this.cloneGithubRepo(target.slug, workspacePath);
      }
      return { workspaceId, cwd: workspacePath };
    }

    const cwd = target.appendWorkspaceId ? path.join(target.rootPath, workspaceId) : target.rootPath;
    await this.fsImpl.mkdir(cwd, { recursive: true });
    return { workspaceId, cwd };
  }
}
