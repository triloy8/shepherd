import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

/** Shepherd's layers, lowest first. A layer may import itself and the layers it lists, nothing
 * else: every dependency points down. Composition is the one layer that wires concretes from all. */
const layers: Array<{ name: string; paths: string[]; may: string[] }> = [
  { name: "protocol", paths: ["shared/protocol"], may: [] },
  { name: "ports", paths: ["server/ports"], may: ["protocol"] },
  { name: "provider-support", paths: ["server/providers/shared"], may: ["ports", "protocol"] },
  { name: "provider:claude", paths: ["server/providers/claude"], may: ["provider-support", "ports", "protocol"] },
  { name: "provider:codex", paths: ["server/providers/codex"], may: ["provider-support", "ports", "protocol"] },
  { name: "config", paths: ["server/config"], may: ["protocol"] },
  { name: "storage", paths: ["server/storage"], may: ["ports", "protocol"] },
  // Core's sub-layers, lowest first. Conversation is the heart; signals and lifecycle build on
  // it, and the surface sub-layer serves surfaces from all of them.
  { name: "core:common", paths: ["server/core/common"], may: ["ports", "protocol"] },
  { name: "core:conversation", paths: ["server/core/conversation"], may: ["core:common", "ports", "protocol"] },
  { name: "core:workspace", paths: ["server/core/workspace"], may: ["core:common", "ports", "protocol"] },
  { name: "core:signals", paths: ["server/core/signals"], may: ["core:conversation", "core:common", "ports", "protocol"] },
  { name: "core:lifecycle", paths: ["server/core/lifecycle"], may: ["core:conversation", "core:common", "ports", "protocol"] },
  { name: "core:surface", paths: ["server/core/surface"], may: ["core:signals", "core:lifecycle", "core:workspace", "core:conversation", "core:common", "ports", "protocol"] },
  // Core's front door: surfaces reach core only through it, so everything else in core is internal.
  { name: "core-api", paths: ["server/core/surface_api.ts"], may: ["core:surface", "core:signals", "core:lifecycle", "core:workspace", "core:conversation", "core:common", "ports", "protocol"] },
  { name: "signals", paths: ["server/signals"], may: ["core:signals", "protocol"] },
  { name: "surface-support", paths: ["server/adapters/shared"], may: ["core-api", "ports", "protocol"] },
  { name: "surface:discord", paths: ["server/adapters/discord"], may: ["surface-support", "core-api", "ports", "config", "protocol"] },
  { name: "surface:web", paths: ["server/adapters/web/"], may: ["surface-support", "core-api", "ports", "config", "protocol"] },
  { name: "surface:webhook", paths: ["server/adapters/webhook"], may: ["surface-support", "core-api", "ports", "config", "protocol"] },
  { name: "ui", paths: ["ui/src"], may: ["protocol"] },
  { name: "composition", paths: ["server/runtime", "server/main.ts", "server/surface_definitions.ts"], may: ["*"] },
];

/** Imports that break the rules today, each to be removed by moving code to its layer. The list
 * may only shrink: a fixed import must leave it, and a new violation fails. */
const knownViolations: string[] = [
];

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

function layerOf(path: string) {
  const file = path.replace(/\.js$/, ".ts");
  // Longest match wins, so a file listed by name beats its folder.
  return layers.flatMap(layer => layer.paths.filter(prefix => file.startsWith(prefix) || `${file}/`.startsWith(prefix)).map(prefix => ({ layer, prefix })))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0]?.layer;
}

function violations(): string[] {
  const found: string[] = [];
  for (const root of ["shared", "server", "ui/src"]) for (const file of files(root)) {
    const from = layerOf(file);
    if (!from) { found.push(`${file}: belongs to no layer`); continue; }
    for (const match of readFileSync(file, "utf8").matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g)) {
      const target = normalize(join(dirname(file), match[1]!));
      const to = layerOf(target);
      if (!to || to === from || from.may.includes("*") || from.may.includes(to.name)) continue;
      found.push(`${file} -> ${target.replace(/\.js$/, "")} (${from.name} -> ${to.name})`);
    }
  }
  return found.sort();
}

test("every import points down the layers, apart from the listed violations being removed", () => {
  expect(violations()).toEqual([...knownViolations].sort());
});
