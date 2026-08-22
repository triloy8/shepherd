import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DEFAULT_DEPLOYMENT_COMMAND_TIMEOUT_MS,
  DeploymentService,
  type DeploymentRecord,
  type DeploymentCommandRunner,
} from "../server/core/deployment_service.js";

function makeRunner(options?: {
  status?: string;
  previousCommit?: string;
  deployedCommit?: string;
  failCommand?: string;
  metadata?: DeploymentRecord | null;
  failMetadataWrite?: boolean;
}) {
  const calls: string[] = [];
  const timeoutValues: number[] = [];
  const previousCommit = options?.previousCommit ?? "1111111111111111111111111111111111111111";
  const deployedCommit = options?.deployedCommit ?? "2222222222222222222222222222222222222222";
  let checkout = previousCommit;
  let metadata = options?.metadata ?? null;
  const metadataWrites: DeploymentRecord[] = [];

  const runCommand: DeploymentCommandRunner = async (executable, args, commandOptions) => {
    const command = [executable, ...args].join(" ");
    calls.push(command);
    timeoutValues.push(commandOptions.timeoutMs);

    if (command === "git status --porcelain --untracked-files=all") {
      return { stdout: options?.status ?? "", stderr: "" };
    }
    if (command === "git rev-parse HEAD") {
      return { stdout: `${checkout}\n`, stderr: "" };
    }
    if (command === "git rev-parse FETCH_HEAD") {
      return { stdout: `${deployedCommit}\n`, stderr: "" };
    }
    if (executable === "git" && args[0] === "checkout") {
      checkout = args.at(-1) ?? checkout;
      return { stdout: "", stderr: "" };
    }
    if (options?.failCommand && command === options.failCommand) {
      const error = new Error(`${command} failed`) as Error & { stderr: string };
      error.stderr = "validation output";
      throw error;
    }
    return { stdout: "", stderr: "" };
  };

  return {
    calls,
    timeoutValues,
    runCommand,
    getCheckout: () => checkout,
    metadataStore: {
      async read() {
        return metadata;
      },
      async write(record: DeploymentRecord) {
        if (options?.failMetadataWrite) throw new Error("metadata unavailable");
        metadata = record;
        metadataWrites.push(record);
      },
    },
    metadataWrites,
  };
}

describe("DeploymentService", () => {
  test("checks out and validates the latest origin/main commit", async () => {
    const runner = makeRunner();
    const service = new DeploymentService({
      projectDir: "/srv/shepherd",
      runCommand: runner.runCommand,
      metadataStore: runner.metadataStore,
    });

    await expect(service.deploy()).resolves.toEqual({
      previousCommit: "1111111111111111111111111111111111111111",
      deployedCommit: "2222222222222222222222222222222222222222",
      changed: true,
      target: { kind: "main" },
    });
    expect(runner.calls).toEqual([
      "git status --porcelain --untracked-files=all",
      "git rev-parse HEAD",
      "git fetch --quiet --no-tags origin refs/heads/main",
      "git rev-parse FETCH_HEAD",
      "git checkout --quiet --detach 2222222222222222222222222222222222222222",
      "bun install --frozen-lockfile",
      "bun run check",
      "bun test",
    ]);
    expect(runner.metadataWrites).toEqual([{
      version: 1,
      target: { kind: "main" },
      deployedCommit: "2222222222222222222222222222222222222222",
    }]);
    expect(new Set(runner.timeoutValues)).toEqual(
      new Set([DEFAULT_DEPLOYMENT_COMMAND_TIMEOUT_MS]),
    );
  });

  test("refuses to deploy over a dirty checkout", async () => {
    const runner = makeRunner({ status: " M server/adapters/discord/bot.ts\n" });
    const service = new DeploymentService({
      runCommand: runner.runCommand,
      metadataStore: runner.metadataStore,
    });

    await expect(service.deploy()).rejects.toThrow("deployed checkout has local changes");
    expect(runner.calls).toEqual(["git status --porcelain --untracked-files=all"]);
  });

  test("validates and restarts even when main is already checked out", async () => {
    const commit = "1111111111111111111111111111111111111111";
    const runner = makeRunner({ deployedCommit: commit });
    const service = new DeploymentService({
      runCommand: runner.runCommand,
      metadataStore: runner.metadataStore,
    });

    await expect(service.deploy()).resolves.toEqual({
      previousCommit: commit,
      deployedCommit: commit,
      changed: false,
      target: { kind: "main" },
    });
    expect(runner.calls).not.toContain(`git checkout --quiet --detach ${commit}`);
    expect(runner.calls.slice(-3)).toEqual([
      "bun install --frozen-lockfile",
      "bun run check",
      "bun test",
    ]);
  });

  test("restores the previous commit and dependencies when validation fails", async () => {
    const runner = makeRunner({ failCommand: "bun run check" });
    const service = new DeploymentService({
      runCommand: runner.runCommand,
      metadataStore: runner.metadataStore,
    });

    await expect(service.deploy()).rejects.toThrow(
      "restored 1111111111111111111111111111111111111111",
    );
    expect(runner.getCheckout()).toBe("1111111111111111111111111111111111111111");
    expect(runner.calls.slice(-2)).toEqual([
      "git checkout --quiet --detach 1111111111111111111111111111111111111111",
      "bun install --frozen-lockfile",
    ]);
  });

  test("passes a configured timeout to every deployment command", async () => {
    const runner = makeRunner();
    const service = new DeploymentService({
      runCommand: runner.runCommand,
      commandTimeoutMs: 45 * 60 * 1000,
      metadataStore: runner.metadataStore,
    });

    await service.deploy();

    expect(new Set(runner.timeoutValues)).toEqual(new Set([45 * 60 * 1000]));
  });

  test("rejects invalid deployment command timeouts", () => {
    expect(() => new DeploymentService({ commandTimeoutMs: 0 })).toThrow(
      "Deployment command timeout must be a positive number.",
    );
  });

  test("validates, fetches, and records an exact preview branch", async () => {
    const runner = makeRunner();
    const service = new DeploymentService({
      runCommand: runner.runCommand,
      metadataStore: runner.metadataStore,
    });

    await expect(service.deploy({ kind: "branch", branch: "feat/user-test" })).resolves.toEqual({
      previousCommit: "1111111111111111111111111111111111111111",
      deployedCommit: "2222222222222222222222222222222222222222",
      changed: true,
      target: { kind: "branch", branch: "feat/user-test" },
    });
    expect(runner.calls.slice(0, 5)).toEqual([
      "git check-ref-format --branch feat/user-test",
      "git status --porcelain --untracked-files=all",
      "git rev-parse HEAD",
      "git fetch --quiet --no-tags origin refs/heads/feat/user-test",
      "git rev-parse FETCH_HEAD",
    ]);
    expect(runner.metadataWrites[0]?.target).toEqual({
      kind: "branch",
      branch: "feat/user-test",
    });
  });

  test("rejects an invalid preview branch before touching the checkout", async () => {
    const runner = makeRunner({ failCommand: "git check-ref-format --branch invalid..branch" });
    const service = new DeploymentService({
      runCommand: runner.runCommand,
      metadataStore: runner.metadataStore,
    });

    await expect(service.deploy({ kind: "branch", branch: "invalid..branch" })).rejects.toThrow(
      "Invalid deployment branch: invalid..branch",
    );
    expect(runner.calls).toEqual(["git check-ref-format --branch invalid..branch"]);
  });

  test("reports the recorded source only while it matches HEAD", async () => {
    const matching = makeRunner({
      metadata: {
        version: 1,
        target: { kind: "branch", branch: "feat/user-test" },
        deployedCommit: "1111111111111111111111111111111111111111",
      },
    });
    const matchingService = new DeploymentService({
      runCommand: matching.runCommand,
      metadataStore: matching.metadataStore,
    });
    await expect(matchingService.readStatus()).resolves.toEqual({
      deployedCommit: "1111111111111111111111111111111111111111",
      target: { kind: "branch", branch: "feat/user-test" },
      deploymentInProgress: false,
    });

    const stale = makeRunner({
      metadata: {
        version: 1,
        target: { kind: "main" },
        deployedCommit: "0000000000000000000000000000000000000000",
      },
    });
    const staleService = new DeploymentService({
      runCommand: stale.runCommand,
      metadataStore: stale.metadataStore,
    });
    await expect(staleService.readStatus()).resolves.toEqual({
      deployedCommit: "1111111111111111111111111111111111111111",
      target: null,
      deploymentInProgress: false,
    });
  });

  test("restores the previous commit when deployment metadata cannot be recorded", async () => {
    const runner = makeRunner({ failMetadataWrite: true });
    const service = new DeploymentService({
      runCommand: runner.runCommand,
      metadataStore: runner.metadataStore,
    });

    await expect(service.deploy({ kind: "branch", branch: "feat/user-test" })).rejects.toThrow(
      "Deployment status update failed for 2222222222222222222222222222222222222222; restored 1111111111111111111111111111111111111111",
    );
    expect(runner.getCheckout()).toBe("1111111111111111111111111111111111111111");
    expect(runner.calls.slice(-2)).toEqual([
      "git checkout --quiet --detach 1111111111111111111111111111111111111111",
      "bun install --frozen-lockfile",
    ]);
  });

  test("persists deployment metadata under the Git directory across service instances", async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "shepherd-deployment-"));
    await mkdir(path.join(projectDir, ".git"));
    const runner = makeRunner();

    try {
      const service = new DeploymentService({
        projectDir,
        runCommand: runner.runCommand,
      });
      await service.deploy({ kind: "branch", branch: "feat/user-test" });

      expect(JSON.parse(await readFile(
        path.join(projectDir, ".git", "shepherd-deployment.json"),
        "utf8",
      ))).toEqual({
        version: 1,
        target: { kind: "branch", branch: "feat/user-test" },
        deployedCommit: "2222222222222222222222222222222222222222",
      });

      const restartedService = new DeploymentService({
        projectDir,
        runCommand: runner.runCommand,
      });
      await expect(restartedService.readStatus()).resolves.toEqual({
        deployedCommit: "2222222222222222222222222222222222222222",
        target: { kind: "branch", branch: "feat/user-test" },
        deploymentInProgress: false,
      });
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
