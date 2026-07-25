import { describe, expect, test } from "bun:test";

import {
  DEFAULT_DEPLOYMENT_COMMAND_TIMEOUT_MS,
  DeploymentService,
  type DeploymentCommandRunner,
} from "../server/core/deployment_service.js";

function makeRunner(options?: {
  status?: string;
  previousCommit?: string;
  deployedCommit?: string;
  failCommand?: string;
}) {
  const calls: string[] = [];
  const timeoutValues: number[] = [];
  const previousCommit = options?.previousCommit ?? "1111111111111111111111111111111111111111";
  const deployedCommit = options?.deployedCommit ?? "2222222222222222222222222222222222222222";
  let checkout = previousCommit;

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
  };
}

describe("DeploymentService", () => {
  test("checks out and validates the latest origin/main commit", async () => {
    const runner = makeRunner();
    const service = new DeploymentService({
      projectDir: "/srv/shepherd",
      runCommand: runner.runCommand,
    });

    await expect(service.deployLatestMain()).resolves.toEqual({
      previousCommit: "1111111111111111111111111111111111111111",
      deployedCommit: "2222222222222222222222222222222222222222",
      changed: true,
    });
    expect(runner.calls).toEqual([
      "git status --porcelain --untracked-files=all",
      "git rev-parse HEAD",
      "git fetch --quiet origin main",
      "git rev-parse FETCH_HEAD",
      "git checkout --quiet --detach 2222222222222222222222222222222222222222",
      "bun install --frozen-lockfile",
      "bun run check",
      "bun test",
    ]);
    expect(new Set(runner.timeoutValues)).toEqual(
      new Set([DEFAULT_DEPLOYMENT_COMMAND_TIMEOUT_MS]),
    );
  });

  test("refuses to deploy over a dirty checkout", async () => {
    const runner = makeRunner({ status: " M server/adapters/discord/bot.ts\n" });
    const service = new DeploymentService({ runCommand: runner.runCommand });

    await expect(service.deployLatestMain()).rejects.toThrow("deployed checkout has local changes");
    expect(runner.calls).toEqual(["git status --porcelain --untracked-files=all"]);
  });

  test("validates and restarts even when main is already checked out", async () => {
    const commit = "1111111111111111111111111111111111111111";
    const runner = makeRunner({ deployedCommit: commit });
    const service = new DeploymentService({ runCommand: runner.runCommand });

    await expect(service.deployLatestMain()).resolves.toEqual({
      previousCommit: commit,
      deployedCommit: commit,
      changed: false,
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
    const service = new DeploymentService({ runCommand: runner.runCommand });

    await expect(service.deployLatestMain()).rejects.toThrow(
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
    });

    await service.deployLatestMain();

    expect(new Set(runner.timeoutValues)).toEqual(new Set([45 * 60 * 1000]));
  });

  test("rejects invalid deployment command timeouts", () => {
    expect(() => new DeploymentService({ commandTimeoutMs: 0 })).toThrow(
      "Deployment command timeout must be a positive number.",
    );
  });
});
