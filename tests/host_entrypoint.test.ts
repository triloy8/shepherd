import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const exec = promisify(execFile);
const main = resolve(import.meta.dir, "../server/main.ts");

test("source launcher checks selected configuration without connecting and reports invalid selection", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "shepherd-launch-"));
  // Keep this test independent of real service credentials and runtime settings.
  const env = { PATH: process.env.PATH, HOME: cwd };
  try {
    await mkdir(join(cwd, "envs"));
    await writeFile(join(cwd, "envs/common.env"), "SHEPHERD_SURFACES=discord\n");
    await writeFile(join(cwd, "envs/discord.env"), "DISCORD_BOT_TOKEN=test-not-a-real-token\n");
    const valid = await exec(process.execPath, [main, "--check-config"], { cwd, env, timeout: 15_000 });
    expect(valid.stdout).toContain("Selected surfaces: discord");
    expect(valid.stdout).not.toContain("bridge ready");
    await writeFile(join(cwd, "envs/common.env"), "SHEPHERD_SURFACES=web\n");
    const unknown = await exec(process.execPath, [main], { cwd, env, timeout: 15_000 }).catch((error) => error);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("Surface 'web' is not available");
    await writeFile(join(cwd, "envs/common.env"), "SHEPHERD_SURFACES=discord\n");
    await rm(join(cwd, "envs/discord.env"));
    const missing = await exec(process.execPath, [main, "--check-config"], { cwd, env, timeout: 15_000 }).catch((error) => error);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("Missing DISCORD_BOT_TOKEN");
  } finally { await rm(cwd, { recursive: true, force: true }); }
}, 30_000);
