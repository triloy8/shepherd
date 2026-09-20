import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("package test command forwards the configured timeout to Bun", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shepherd-test-timeout-"));
  try {
    const probe = join(directory, "timeout.test.ts");
    await writeFile(probe, `import { test } from "bun:test";
      test("command probe", () => {});`);
    const { stderr } = await execFileAsync(process.execPath, ["run", "test", probe], {
      cwd: resolve(import.meta.dir, ".."),
      timeout: 60_000,
    });
    // Bun's script runner prints the executed command. Check the actual package
    // entrypoint without making deployment depend on a wall-clock sleep.
    expect(stderr).toMatch(/^\$ bun test --timeout 30000 /m);
    expect(stderr).toContain("1 pass");
    expect(stderr).toContain("0 fail");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);
