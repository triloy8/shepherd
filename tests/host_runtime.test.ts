import { expect, test } from "bun:test";
import { readRuntimeConfig } from "../server/config/runtime_environment.js";
import { createHostRuntime, createGithubWorkspacePorts } from "../server/runtime/host_runtime.js";

test("shared host validates configuration without a transport", async () => {
  expect(readRuntimeConfig({})).toMatchObject({ policy: null, signals: { enabled: false } });
  expect(readRuntimeConfig({ SHEPHERD_POLICY: "bypass" }).policy).toEqual({ writes: "any", network: "any", review: "none" });
  expect(readRuntimeConfig({ SHEPHERD_POLICY: "workspace" }).policy).toEqual({ writes: "workspace", network: "any", review: "risky" });
  expect(() => readRuntimeConfig({ SHEPHERD_POLICY: "never" })).toThrow("SHEPHERD_POLICY must be one of");
  // The removed settings fail loudly instead of silently dropping a configured mode.
  expect(() => readRuntimeConfig({ SHEPHERD_APPROVAL_MODE: "bypass" })).toThrow("SHEPHERD_APPROVAL_MODE was replaced by SHEPHERD_POLICY");
  expect(() => readRuntimeConfig({ SHEPHERD_SANDBOX_MODE: "unrestricted" })).toThrow("SHEPHERD_SANDBOX_MODE was replaced by SHEPHERD_POLICY");
  for (const value of ["0", "-1", "NaN", "Infinity"]) {
    expect(() => readRuntimeConfig({ SHEPHERD_DEPLOY_COMMAND_TIMEOUT_MS: value })).toThrow("positive number");
  }
  const config = readRuntimeConfig({ SHEPHERD_POLICY: "workspace", SHEPHERD_DEPLOY_COMMAND_TIMEOUT_MS: "1200" });
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
