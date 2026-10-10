import { expect, test } from "bun:test";
import { readRuntimeConfig } from "../server/config/runtime_environment.js";
import { createHostRuntime, createGithubWorkspacePorts } from "../server/runtime/host_runtime.js";

test("shared host validates configuration without a transport", async () => {
  expect(readRuntimeConfig({})).toMatchObject({ approvalPolicy: "on-request", defaultSandbox: undefined, signals: { enabled: false } });
  expect(() => readRuntimeConfig({ SHEPHERD_SANDBOX_MODE: "typo" })).toThrow("SHEPHERD_SANDBOX_MODE");
  for (const value of ["0", "-1", "NaN", "Infinity"]) {
    expect(() => readRuntimeConfig({ SHEPHERD_DEPLOY_COMMAND_TIMEOUT_MS: value })).toThrow("positive number");
  }
  const config = readRuntimeConfig({ SHEPHERD_SANDBOX_MODE: "workspace_write", SHEPHERD_APPROVAL_MODE: "bypass", SHEPHERD_DEPLOY_COMMAND_TIMEOUT_MS: "1200" });
  const host = createHostRuntime({ config, projectDir: "/tmp" });
  expect(host.config).toBe(config);
  expect(host.shepherd.isQuiescing()).toBe(false);
  await host.shepherd.shutdown();
});

test("workspace ports preserve argument boundaries and the host working directory", async () => {
  const calls: unknown[] = [];
  const ports = createGithubWorkspacePorts("/host checkout", async (args, cwd) => {
    calls.push({ args, cwd }); return "owner/repo";
  });
  expect(await ports.resolveGithubRepo("owner/repo")).toBe("owner/repo");
  await ports.cloneGithubRepo("owner/repo", "/workspace with spaces");
  expect(calls).toEqual([
    { args: ["repo", "view", "owner/repo", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], cwd: "/host checkout" },
    { args: ["repo", "clone", "owner/repo", "/workspace with spaces", "--", "--recurse-submodules"], cwd: "/host checkout" },
  ]);
});
