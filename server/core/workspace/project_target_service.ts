import path from "node:path";
import { homedir } from "node:os";

export type GithubProjectTarget = {
  kind: "github";
  slug: string;
  display: string;
};

export type LocalProjectTarget = {
  kind: "local";
  rootPath: string;
  display: string;
  appendWorkspaceId: boolean;
  /** Verified repository identity for a local checkout; workspace operations still use rootPath. */
  repositorySlug?: string;
};

export type ProjectTarget = GithubProjectTarget | LocalProjectTarget;

export type ProjectTargetResolver = {
  resolveGithubRepo?: (slug: string) => Promise<string>;
  resolveGithubRepoFromWorkspace?: (workspacePath: string) => Promise<string | null>;
};

const GITHUB_SLUG_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Extract only a GitHub repository named by a checkout's configured remote URL. */
export function githubRepositorySlugFromRemote(remote: string): string | null {
  const value = remote.trim();
  if (!value) return null;
  let repositoryPath: string | null = null;
  const scp = /^(?:[^@/:]+@)?github\.com:([^?#]+)$/i.exec(value);
  if (scp) repositoryPath = scp[1]!;
  else {
    try {
      const url = new URL(value);
      if (!["https:", "ssh:", "git:"].includes(url.protocol) || url.hostname.toLowerCase() !== "github.com") return null;
      repositoryPath = url.pathname.replace(/^\//, "");
    } catch { return null; }
  }
  const slug = repositoryPath.replace(/\.git$/i, "");
  return GITHUB_SLUG_PATTERN.test(slug) ? slug : null;
}

function parseGithubProjectTarget(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || !GITHUB_SLUG_PATTERN.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function parseLocalProjectTarget(value: string): LocalProjectTarget | null {
  const trimmed = value.trim();
  if (trimmed === "~") {
    return {
      kind: "local",
      rootPath: path.join(homedir(), ".agent-workspaces", "local"),
      display: "~",
      appendWorkspaceId: true,
    };
  }
  if (trimmed.startsWith("~/")) {
    return {
      kind: "local",
      rootPath: path.join(homedir(), trimmed.slice(2)),
      display: trimmed,
      appendWorkspaceId: false,
    };
  }
  return null;
}

export async function resolveProjectTarget(
  input: string,
  resolver: ProjectTargetResolver = {},
): Promise<ProjectTarget> {
  const localTarget = parseLocalProjectTarget(input);
  if (localTarget) {
    return localTarget;
  }

  const githubSlug = parseGithubProjectTarget(input);
  if (!githubSlug) {
    throw new Error("Invalid repo target. Use `<owner>/<repo>`, `~`, or `~/path`.");
  }

  const resolvedSlug = resolver.resolveGithubRepo
    ? await resolver.resolveGithubRepo(githubSlug)
    : githubSlug;
  if (!resolvedSlug || resolvedSlug.trim().toLowerCase() !== githubSlug.toLowerCase()) {
    throw new Error(`Unable to resolve repo ${githubSlug}.`);
  }

  return {
    kind: "github",
    slug: resolvedSlug,
    display: resolvedSlug,
  };
}

export async function resolveWorkspaceRepositorySlug(
  workspacePath: string,
  resolver: ProjectTargetResolver = {},
): Promise<string | null> {
  const value = await resolver.resolveGithubRepoFromWorkspace?.(workspacePath);
  return value ? parseGithubProjectTarget(value) : null;
}

export function describeProjectTarget(target: ProjectTarget): string {
  return target.kind === "local" ? target.repositorySlug ?? target.display : target.display;
}
