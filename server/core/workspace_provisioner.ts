import { ApplicationActionError } from "./action_error.js";
import { createHash } from "node:crypto";
import path from "node:path";
import { homedir } from "node:os";
import { promises as fs } from "node:fs";

import type { ProjectTarget } from "./project_target_service.js";

type FileSystemLike = {
  stat: typeof fs.stat;
  mkdir: typeof fs.mkdir;
  rm: typeof fs.rm;
};

export type WorkspaceReservation = {
  workspaceId: string;
  cwd: string;
  /** Removes only a dedicated directory exclusively created by this reservation. */
  rollback(): Promise<void>;
};

export type WorkspaceProvisionerOptions = {
  fsImpl?: FileSystemLike;
  cloneGithubRepo?: (slug: string, workspacePath: string) => Promise<void>;
  homedirPath?: string;
};

function repoNameFromSlug(slug: string): string {
  return slug.split("/")[1] ?? slug;
}

/** Preserve deployed UUID names; opaque application IDs need a portable, bounded directory name. */
function workspaceDirectoryName(id: string): string {
  return /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : createHash("sha256").update(id).digest("hex");
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

  async requireExistingWorkspace(cwd: string): Promise<void> {
    try {
      if (!path.isAbsolute(cwd) || !(await this.fsImpl.stat(cwd)).isDirectory()) throw new Error("Invalid directory");
    } catch {
      throw new ApplicationActionError({ code: "workspace_unavailable" });
    }
  }

  async reserveWorkspace(target: ProjectTarget, workspaceId: string): Promise<WorkspaceReservation> {
    const dedicated = target.kind === "github" || target.appendWorkspaceId;
    const cwd = target.kind === "github"
      ? path.join(this.homedirPath, ".agent-workspaces", repoNameFromSlug(target.slug), workspaceDirectoryName(workspaceId))
      : target.appendWorkspaceId ? path.join(target.rootPath, workspaceDirectoryName(workspaceId)) : target.rootPath;
    let owned = false;
    const rollback = async () => {
      if (owned) {
        await this.fsImpl.rm(cwd, { recursive: true, force: true });
        owned = false;
      }
    };
    if (dedicated) {
      await this.fsImpl.mkdir(path.dirname(cwd), { recursive: true });
      try {
        // Exclusive creation establishes ownership; existing workspaces are never rolled back.
        await this.fsImpl.mkdir(cwd);
        owned = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    try {
      await this.provisionWorkspace(target, workspaceId);
      return { workspaceId, cwd, rollback };
    } catch (error) {
      await rollback();
      throw error;
    }
  }

  async provisionWorkspace(
    target: ProjectTarget,
    workspaceId: string,
  ): Promise<{ workspaceId: string; cwd: string }> {
    if (target.kind === "github") {
      const repoName = repoNameFromSlug(target.slug);
      const workspacePath = path.join(this.homedirPath, ".agent-workspaces", repoName, workspaceDirectoryName(workspaceId));
      const marker = path.join(workspacePath, ".git");
      try {
        await this.fsImpl.stat(marker);
      } catch {
        await this.fsImpl.mkdir(path.dirname(workspacePath), { recursive: true });
        await this.cloneGithubRepo(target.slug, workspacePath);
      }
      return { workspaceId, cwd: workspacePath };
    }

    const cwd = target.appendWorkspaceId ? path.join(target.rootPath, workspaceDirectoryName(workspaceId)) : target.rootPath;
    await this.fsImpl.mkdir(cwd, { recursive: true });
    return { workspaceId, cwd };
  }
}
