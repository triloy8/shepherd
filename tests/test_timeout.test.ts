import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("package test command applies the configured timeout beyond five seconds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shepherd-test-timeout-"));
  try {
    const probe = join(directory, "timeout.test.ts");
    await writeFile(probe, `import { test } from "bun:test";
      test("exceeds the runtime default", async () => { await Bun.sleep(5_500); });`);
    const { stderr } = await execFileAsync(process.execPath, ["run", "test", probe], {
      cwd: resolve(import.meta.dir, ".."),
      timeout: 20_000,
    });
    expect(stderr).toContain("1 pass");
    expect(stderr).toContain("0 fail");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
