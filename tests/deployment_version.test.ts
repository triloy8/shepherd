import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

test("every deployment default matches the documented Codex schema baseline", async () => {
  const root = path.resolve(import.meta.dir, "..");
  const read = (file: string) => readFile(path.join(root, file), "utf8");
  const [matrix, docker, compose, setup] = await Promise.all([
    read(".docs/schema-parity-matrix.md"), read("Dockerfile"), read("compose.yaml"), read("deploy/ubuntu/setup.sh"),
  ]);
  const version = matrix.match(/Codex version: `codex-cli ([\d.]+)`/)?.[1];
  expect(version).toBeDefined();
  expect(docker.match(/ARG CODEX_VERSION=([\d.]+)/)?.[1]).toBe(version);
  expect(compose.match(/CODEX_VERSION: "([\d.]+)"/)?.[1]).toBe(version);
  expect(setup.match(/CODEX_VERSION:-([\d.]+)/)?.[1]).toBe(version);
});
