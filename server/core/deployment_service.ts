import { execFile } from "node:child_process";
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
};

export type DeploymentServiceOptions = {
  projectDir?: string;
  runCommand?: DeploymentCommandRunner;
  commandTimeoutMs?: number;
};

function formatCommandError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const details = error as Error & { stderr?: string; stdout?: string };
  const output = details.stderr?.trim() || details.stdout?.trim();
  return output ? `${error.message}\n${output}` : error.message;
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

  async deployLatestMain(): Promise<DeploymentResult> {
    if (this.deploymentInProgress) {
      throw new Error("A deployment is already in progress.");
    }

    this.deploymentInProgress = true;
    try {
      return await this.performDeployment();
    } finally {
      this.deploymentInProgress = false;
    }
  }

  private async performDeployment(): Promise<DeploymentResult> {
    const status = await this.git(["status", "--porcelain", "--untracked-files=all"]);
    if (status.trim()) {
      throw new Error("The deployed checkout has local changes. Commit or remove them before deploying.");
    }

    const previousCommit = await this.readCommit("HEAD");
    await this.git(["fetch", "--quiet", "origin", "main"]);
    const deployedCommit = await this.readCommit("FETCH_HEAD");
    const changed = previousCommit !== deployedCommit;

    if (changed) {
      await this.git(["checkout", "--quiet", "--detach", deployedCommit]);
    }

    try {
      await this.run("bun", ["install", "--frozen-lockfile"]);
      await this.run("bun", ["run", "check"]);
      await this.run("bun", ["test"]);
    } catch (error) {
      if (!changed) {
        throw new Error(`Deployment validation failed; the current commit was not changed.\n${formatCommandError(error)}`);
      }

      try {
        await this.git(["checkout", "--quiet", "--detach", previousCommit]);
        await this.run("bun", ["install", "--frozen-lockfile"]);
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
