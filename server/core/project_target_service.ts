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
};

export type ProjectTarget = GithubProjectTarget | LocalProjectTarget;

export type ProjectTargetResolver = {
  resolveGithubRepo?: (slug: string) => Promise<string>;
};

const GITHUB_SLUG_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

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

export function describeProjectTarget(target: ProjectTarget): string {
  return target.display;
}
