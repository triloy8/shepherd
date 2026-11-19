import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadCommonEnvironment } from "../server/config/environment.js";

const modulePath = path.resolve(import.meta.dir, "../server/config/environment.ts");

test("child environments reread edited common files while retaining explicit overrides", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "shepherd-env-child-"));
  try {
    await mkdir(path.join(directory, "envs"));
    await writeFile(path.join(directory, "envs/common.env"), "SHEPHERD_TEST_FILE=initial\nSHEPHERD_TEST_REMOVED=old\nSHEPHERD_TEST_EXPLICIT=file\n");

    const hostEnvironment = { SHEPHERD_TEST_EXPLICIT: "launcher" };
    const childEnvironment = loadCommonEnvironment(hostEnvironment, directory);

    expect(hostEnvironment).toMatchObject({
      SHEPHERD_TEST_FILE: "initial",
      SHEPHERD_TEST_REMOVED: "old",
      SHEPHERD_TEST_EXPLICIT: "launcher",
    });
    expect(childEnvironment).toEqual({ SHEPHERD_TEST_EXPLICIT: "launcher" });

    await writeFile(path.join(directory, "envs/common.env"), "SHEPHERD_TEST_FILE=updated\nSHEPHERD_TEST_EXPLICIT=file-updated\n");
    const freshChildEnvironment = { ...childEnvironment };
    loadCommonEnvironment(freshChildEnvironment, directory);

    expect(freshChildEnvironment).toEqual({
      SHEPHERD_TEST_EXPLICIT: "launcher",
      SHEPHERD_TEST_FILE: "updated",
    });
    expect(freshChildEnvironment.SHEPHERD_TEST_REMOVED).toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("configuration uses only envs and preserves process/common/scope precedence", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "shepherd-env-"));
  const readConfig = async () => {
    const proc = Bun.spawn([process.execPath, "-e", `import { loadCommonEnvironment, readSurfaceEnvironment } from ${JSON.stringify(modulePath)}; loadCommonEnvironment(); const env = readSurfaceEnvironment("discord"); console.log(JSON.stringify([env.SHEPHERD_TEST_A, env.SHEPHERD_TEST_B, env.SHEPHERD_TEST_C]));`], {
      cwd: directory,
      env: { ...process.env, SHEPHERD_TEST_A: "process", SHEPHERD_TEST_B: undefined, SHEPHERD_TEST_C: undefined },
      stdout: "pipe", stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    return JSON.parse(output);
  };
  try {
    await mkdir(path.join(directory, "environment"));
    await writeFile(path.join(directory, "environment/common.env"), "SHEPHERD_TEST_B=retired\n");
    expect(await readConfig()).toEqual(["process", null, null]);
    await mkdir(path.join(directory, "envs"));
    await writeFile(path.join(directory, "envs/common.env"), "SHEPHERD_TEST_A=common\nSHEPHERD_TEST_B=common\n");
    await writeFile(path.join(directory, "envs/discord.env"), "SHEPHERD_TEST_B=scope\nSHEPHERD_TEST_C=scope\n");
    expect(await readConfig()).toEqual(["process", "common", "scope"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
