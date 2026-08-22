import { execFile } from "node:child_process";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
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

export type DeploymentRecord = {
  version: 1;
  target: DeploymentTarget;
  deployedCommit: string;
};

export type DeploymentStatus = {
  deployedCommit: string;
  target: DeploymentTarget | null;
  deploymentInProgress: boolean;
};

export type DeploymentMetadataStore = {
  read: () => Promise<DeploymentRecord | null>;
  write: (record: DeploymentRecord) => Promise<void>;
};

export type DeploymentServiceOptions = {
  projectDir?: string;
  runCommand?: DeploymentCommandRunner;
  commandTimeoutMs?: number;
  metadataStore?: DeploymentMetadataStore;
};

function isDeploymentTarget(value: unknown): value is DeploymentTarget {
  if (!value || typeof value !== "object") return false;
  const target = value as { kind?: unknown; branch?: unknown };
  return target.kind === "main"
    || (target.kind === "branch" && typeof target.branch === "string" && target.branch.length > 0);
}

function parseDeploymentRecord(value: unknown): DeploymentRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { version?: unknown; target?: unknown; deployedCommit?: unknown };
  if (
    record.version !== 1
    || !isDeploymentTarget(record.target)
    || typeof record.deployedCommit !== "string"
    || record.deployedCommit.length === 0
  ) {
    return null;
  }
  return {
    version: 1,
    target: record.target,
    deployedCommit: record.deployedCommit,
  };
}

function fileMetadataStore(filePath: string): DeploymentMetadataStore {
  return {
    async read() {
      try {
        return parseDeploymentRecord(JSON.parse(await readFile(filePath, "utf8")));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        if (error instanceof SyntaxError) return null;
        throw error;
      }
    },
    async write(record) {
      const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
      try {
        await writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
        await rename(temporaryPath, filePath);
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
      }
    },
  };
}

export function deploymentTargetBranch(target: DeploymentTarget): string {
  return target.kind === "main" ? "main" : target.branch;
}

export function deploymentTargetLabel(target: DeploymentTarget): string {
  return `origin/${deploymentTargetBranch(target)}`;
}

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
  private readonly metadataStore: DeploymentMetadataStore;
  private deploymentInProgress = false;

  constructor(options: DeploymentServiceOptions = {}) {
    this.projectDir = options.projectDir ?? process.cwd();
    this.runCommand = options.runCommand ?? defaultCommandRunner;
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_DEPLOYMENT_COMMAND_TIMEOUT_MS;
    this.metadataStore = options.metadataStore
      ?? fileMetadataStore(path.join(this.projectDir, ".git", "shepherd-deployment.json"));
    if (!Number.isFinite(this.commandTimeoutMs) || this.commandTimeoutMs <= 0) {
      throw new Error("Deployment command timeout must be a positive number.");
    }
  }

  isDeploymentInProgress(): boolean {
    return this.deploymentInProgress;
  }

  async readStatus(): Promise<DeploymentStatus> {
    const deployedCommit = await this.readCommit("HEAD");
    const record = await this.metadataStore.read();
    return {
      deployedCommit,
      target: record?.deployedCommit === deployedCommit ? record.target : null,
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
    await this.git(["fetch", "--quiet", "--no-tags", "origin", `refs/heads/${branch}`]);
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

    try {
      await this.metadataStore.write({
        version: 1,
        target,
        deployedCommit,
      });
    } catch (error) {
      if (!changed) {
        throw new Error(
          `Deployment status update failed; the current commit was not changed.\n${formatCommandError(error)}`,
        );
      }

      try {
        await this.git(["checkout", "--quiet", "--detach", previousCommit]);
        await this.run("bun", ["install", "--frozen-lockfile"]);
      } catch (rollbackError) {
        throw new Error(
          [
            `Deployment status update failed for ${deployedCommit}.`,
            `Automatic rollback to ${previousCommit} also failed: ${formatCommandError(rollbackError)}`,
            `Original status error: ${formatCommandError(error)}`,
          ].join("\n"),
        );
      }

      throw new Error(
        `Deployment status update failed for ${deployedCommit}; restored ${previousCommit}.\n${formatCommandError(error)}`,
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
