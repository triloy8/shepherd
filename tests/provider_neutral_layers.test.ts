import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Provider-specific code lives in server/providers and is wired in server/runtime. Everything a
// provider plugs into stays neutral: no provider names and no imports of adapter code.
const neutral = ["server/core", "server/ports", "server/adapters", "shared", "ui/src"];
const names = /codex|claude|anthropic|openai/i;
const adapterImport = /from\s+["'][^"']*\/providers\//;

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

test("neutral layers name no provider and import no provider adapter", () => {
  const leaks = neutral.flatMap(directory => files(directory)).flatMap(path =>
    readFileSync(path, "utf8").split("\n").flatMap((line, index) => names.test(line) || adapterImport.test(line) ? [`${path}:${index + 1}: ${line.trim()}`] : []));
  expect(leaks).toEqual([]);
});
