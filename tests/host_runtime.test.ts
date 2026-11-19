import { expect, test } from "bun:test";
import { readRuntimeConfig } from "../server/config/runtime_environment.js";
import { createHostRuntime, createGithubWorkspacePorts } from "../server/runtime/host_runtime.js";
import { githubRepositorySlugFromRemote } from "../server/core/workspace/project_target_service.js";

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

test("workspace repository identity comes from a local GitHub origin without network access", async () => {
  const calls: unknown[] = [];
  const ports = createGithubWorkspacePorts(
    "/host checkout",
    async () => { throw new Error("GitHub CLI should not be called"); },
    async (args, cwd) => { calls.push({ args, cwd }); return "git@github.com:Owner/repo.git\n"; },
  );
  expect(await ports.resolveGithubRepoFromWorkspace("/saved checkout")).toBe("Owner/repo");
  expect(calls).toEqual([{ args: ["remote", "get-url", "origin"], cwd: "/saved checkout" }]);
  expect(githubRepositorySlugFromRemote("https://github.com/acme/project.git")).toBe("acme/project");
  expect(githubRepositorySlugFromRemote("ssh://git@github.com/acme/project")).toBe("acme/project");
  expect(githubRepositorySlugFromRemote("https://github.com.evil.test/acme/project")).toBeNull();
  expect(githubRepositorySlugFromRemote("/workspaces/acme/project")).toBeNull();
  expect(githubRepositorySlugFromRemote("https://github.com/acme/project/tree/main")).toBeNull();
});

test("missing local origin metadata leaves a resumed workspace local", async () => {
  const ports = createGithubWorkspacePorts("/host", async () => "unused", async () => { throw new Error("no origin"); });
  expect(await ports.resolveGithubRepoFromWorkspace("/saved checkout")).toBeNull();
});
