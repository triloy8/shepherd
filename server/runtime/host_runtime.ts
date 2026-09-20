import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readRuntimeConfig, type RuntimeConfig } from "../config/runtime_environment.js";
import { DeploymentService } from "../core/deployment_service.js";
import { ShepherdRuntime } from "./shepherd_runtime.js";

const execFileAsync = promisify(execFile);
export type GithubCommandRunner = (args: string[], cwd: string) => Promise<string>;

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

export function createGithubWorkspacePorts(cwd: string, run: GithubCommandRunner = runGithub) {
  return {
    cloneGithubRepo: async (slug: string, workspacePath: string): Promise<void> => {
      await run(["repo", "clone", slug, workspacePath, "--", "--recurse-submodules"], cwd);
    },
    resolveGithubRepo: (slug: string): Promise<string> =>
      run(["repo", "view", slug, "--json", "nameWithOwner", "--jq", ".nameWithOwner"], cwd),
  };
}

/** Shared host defaults; the launcher loads common configuration first. */
export function createHostRuntime(options: { config?: RuntimeConfig; projectDir?: string; runGithub?: GithubCommandRunner } = {}) {
  const config = options.config ?? readRuntimeConfig();
  const projectDir = options.projectDir ?? process.cwd();
  const deployment = new DeploymentService({ projectDir, commandTimeoutMs: config.deploymentCommandTimeoutMs });
  const runningCommit = execFileAsync("git", ["rev-parse", "HEAD"], { cwd: projectDir, timeout: 5000 }).then(({ stdout }) => stdout.trim(), () => null);
  const shepherd = new ShepherdRuntime({ runningCommit, approvalPolicy: config.approvalPolicy, defaultSandbox: config.defaultSandbox, deployment });
  return { config, shepherd, workspace: createGithubWorkspacePorts(projectDir, options.runGithub) };
}
