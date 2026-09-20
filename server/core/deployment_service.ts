import { stripVTControlCharacters } from "node:util";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const DEFAULT_DEPLOYMENT_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;

export type DeploymentCommandResult = {
  stdout: string;
  stderr: string;
};

export type DeploymentCommandOptions = {
  cwd: string;
  timeoutMs: number;
};

export type DeploymentCommandRunner = (
  executable: string,
  args: string[],
  options: DeploymentCommandOptions,
) => Promise<DeploymentCommandResult>;

export type DeploymentResult = {
  previousCommit: string;
  deployedCommit: string;
  changed: boolean;
  target: DeploymentTarget;
};

export type DeploymentTarget =
  | { kind: "main" }
  | { kind: "branch"; branch: string };

export const MAIN_DEPLOYMENT_TARGET: DeploymentTarget = { kind: "main" };

export type DeploymentStatus = {
  deployedCommit: string;
  matchingRemoteRefs: string[];
  deploymentInProgress: boolean;
};

export type DeploymentServiceOptions = {
  projectDir?: string;
  runCommand?: DeploymentCommandRunner;
  commandTimeoutMs?: number;
};

export function deploymentTargetBranch(target: DeploymentTarget): string {
  return target.kind === "main" ? "main" : target.branch;
}

export function deploymentTargetLabel(target: DeploymentTarget): string {
  return `origin/${deploymentTargetBranch(target)}`;
}

function formatCommandError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const details = error as Error & { stderr?: string; stdout?: string };
  const output = [details.stderr?.trim(), details.stdout?.trim()].filter(Boolean).join("\n");
  if (!output) return error.message;
  // execFile includes stderr in Error.message already. Keep the command heading
  // once, then both output streams, with actionable failure lines first.
  const heading = error.message.split("\n", 1)[0];
  const cleanOutput = stripVTControlCharacters(output);
  const lines = cleanOutput.split("\n");
  const failedTests = lines.filter((line) => /^\s*\(fail\)/.test(line));
  // Passing failure-path tests may intentionally log "error:". Prefer the
  // runner's failure records; retain all diagnostics in the full output below.
  const failures = [...new Set(failedTests.length ? failedTests : lines.filter((line) =>
    /^\s*error:|timed out/i.test(line),
  ))].slice(0, 12);
  return [heading, ...(failures.length ? ["Failure summary:", ...failures, "", "Command output:"] : []), cleanOutput].join("\n");
}

async function defaultCommandRunner(
  executable: string,
  args: string[],
  options: DeploymentCommandOptions,
): Promise<DeploymentCommandResult> {
  const result = await execFileAsync(executable, args, {
    cwd: options.cwd,
    env: process.env,
    timeout: options.timeoutMs,
    killSignal: "SIGTERM",
    maxBuffer: 1024 * 1024 * 20,
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export class DeploymentService {
  private readonly projectDir: string;
  private readonly runCommand: DeploymentCommandRunner;
  private readonly commandTimeoutMs: number;
  private deploymentInProgress = false;

  constructor(options: DeploymentServiceOptions = {}) {
    this.projectDir = options.projectDir ?? process.cwd();
    this.runCommand = options.runCommand ?? defaultCommandRunner;
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_DEPLOYMENT_COMMAND_TIMEOUT_MS;
    if (!Number.isFinite(this.commandTimeoutMs) || this.commandTimeoutMs <= 0) {
      throw new Error("Deployment command timeout must be a positive number.");
    }
  }

  isDeploymentInProgress(): boolean {
    return this.deploymentInProgress;
  }

  async readStatus(): Promise<DeploymentStatus> {
    const deployedCommit = await this.readCommit("HEAD");
    const refs = await this.git([
      "for-each-ref",
      "--format=%(refname:short)",
      "--points-at",
      deployedCommit,
      "refs/remotes/origin",
    ]);
    return {
      deployedCommit,
      matchingRemoteRefs: refs
        .split(/\r?\n/)
        .map((ref) => ref.trim())
        .filter((ref) => ref.length > 0 && ref !== "origin/HEAD")
        .sort(),
      deploymentInProgress: this.deploymentInProgress,
    };
  }

  async deploy(target: DeploymentTarget = MAIN_DEPLOYMENT_TARGET): Promise<DeploymentResult> {
    if (this.deploymentInProgress) {
      throw new Error("A deployment is already in progress.");
    }

    this.deploymentInProgress = true;
    try {
      return await this.performDeployment(target);
    } finally {
      this.deploymentInProgress = false;
    }
  }

  private async performDeployment(target: DeploymentTarget): Promise<DeploymentResult> {
    const branch = deploymentTargetBranch(target);
    if (target.kind === "branch") {
      try {
        await this.git(["check-ref-format", "--branch", branch]);
      } catch {
        throw new Error(`Invalid deployment branch: ${branch}`);
      }
    }

    const status = await this.git(["status", "--porcelain", "--untracked-files=all"]);
    if (status.trim()) {
      throw new Error("The deployed checkout has local changes. Commit or remove them before deploying.");
    }

    const previousCommit = await this.readCommit("HEAD");
    await this.git([
      "fetch",
      "--quiet",
      "--no-tags",
      "origin",
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ]);
    const deployedCommit = await this.readCommit("FETCH_HEAD");
    const changed = previousCommit !== deployedCommit;

    if (changed) {
      await this.git(["checkout", "--quiet", "--detach", deployedCommit]);
    }

    try {
      await this.run("bun", ["install", "--frozen-lockfile"]);
      await this.run("bun", ["run", "check"]);
      await this.run("bun", ["run", "check:config"]);
      await this.run("bun", ["test", "--timeout", "30000"]);
    } catch (error) {
      if (!changed) {
        throw new Error(`Deployment validation failed; the current commit was not changed.\n${formatCommandError(error)}`);
      }

      try {
        await this.git(["checkout", "--quiet", "--detach", previousCommit]);
        await this.run("bun", ["install", "--frozen-lockfile"]);
        // Restore generated artifacts (including UI assets) with the restored source.
        await this.run("bun", ["run", "build"]);
      } catch (rollbackError) {
        throw new Error(
          [
            `Deployment validation failed for ${deployedCommit}.`,
            `Automatic rollback to ${previousCommit} also failed: ${formatCommandError(rollbackError)}`,
            `Original validation error: ${formatCommandError(error)}`,
          ].join("\n"),
        );
      }

      throw new Error(
        `Deployment validation failed for ${deployedCommit}; restored ${previousCommit}.\n${formatCommandError(error)}`,
      );
    }

    return {
      previousCommit,
      deployedCommit,
      changed,
      target,
    };
  }

  private async readCommit(ref: string): Promise<string> {
    const output = await this.git(["rev-parse", ref]);
    const commit = output.trim();
    if (!commit) {
      throw new Error(`Unable to resolve Git commit ${ref}.`);
    }
    return commit;
  }

  private async git(args: string[]): Promise<string> {
    return (await this.run("git", args)).stdout;
  }

  private async run(executable: string, args: string[]): Promise<DeploymentCommandResult> {
    return this.runCommand(executable, args, {
      cwd: this.projectDir,
      timeoutMs: this.commandTimeoutMs,
    });
  }
}
