import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readRuntimeConfig, type RuntimeConfig } from "../config/runtime_environment.js";
import { DeploymentService } from "../core/lifecycle/deployment_service.js";
import { githubRepositorySlugFromRemote } from "../core/workspace/project_target_service.js";
import { ShepherdRuntime } from "./shepherd_runtime.js";

const execFileAsync = promisify(execFile);
export type GithubCommandRunner = (args: string[], cwd: string) => Promise<string>;
export type GitCommandRunner = (args: string[], cwd: string) => Promise<string>;

const runGithub: GithubCommandRunner = async (args, cwd) => {
  try {
    const { stdout } = await execFileAsync("gh", args, {
      cwd, env: process.env, maxBuffer: 1024 * 1024 * 10,
    });
    return stdout.trim();
  } catch (error) {
    throw new Error(`gh ${args.join(" ")} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const runGit: GitCommandRunner = async (args, cwd) => {
  const { stdout } = await execFileAsync("git", args, {
    cwd, env: process.env, timeout: 5000, maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
};

export function createGithubWorkspacePorts(cwd: string, run: GithubCommandRunner = runGithub, git: GitCommandRunner = runGit) {
  return {
    cloneGithubRepo: async (slug: string, workspacePath: string): Promise<void> => {
      await run(["repo", "clone", slug, workspacePath, "--", "--recurse-submodules"], cwd);
    },
    resolveGithubRepo: (slug: string): Promise<string> =>
      run(["repo", "view", slug, "--json", "nameWithOwner", "--jq", ".nameWithOwner"], cwd),
    resolveGithubRepoFromWorkspace: async (workspacePath: string): Promise<string | null> => {
      try {
        return githubRepositorySlugFromRemote(await git(["remote", "get-url", "origin"], workspacePath));
      } catch { return null; }
    },
  };
}

/** Shared host defaults; the launcher loads common configuration first. */
export function createHostRuntime(options: {
  config?: RuntimeConfig;
  projectDir?: string;
  runGithub?: GithubCommandRunner;
  environment?: Record<string, string | undefined>;
} = {}) {
  const config = options.config ?? readRuntimeConfig();
  const projectDir = options.projectDir ?? process.cwd();
  const deployment = new DeploymentService({
    projectDir,
    commandTimeoutMs: config.deploymentCommandTimeoutMs,
    environment: options.environment,
  });
  const runningCommit = execFileAsync("git", ["rev-parse", "HEAD"], { cwd: projectDir, timeout: 5000 }).then(({ stdout }) => stdout.trim(), () => null);
  const shepherd = new ShepherdRuntime({ runningCommit, policy: config.policy, ...(config.defaultProvider ? { defaultProvider: config.defaultProvider } : {}), deployment });
  return { config, shepherd, workspace: createGithubWorkspacePorts(projectDir, options.runGithub) };
}
