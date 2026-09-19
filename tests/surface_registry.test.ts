import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { surfaceRegistry } from "../server/surface_definitions.js";
import { readSurfaceSelection, prepareSurfaces } from "../server/runtime/surface_registry.js";
import { readSurfaceEnvironment } from "../server/config/environment.js";
import type { SurfaceRegistry } from "../server/runtime/surface_registry.js";

test("surface selection defaults only when unset and rejects ambiguous selections", () => {
  expect(readSurfaceSelection(undefined)).toEqual(["discord"]);
  expect(readSurfaceSelection("discord, web")).toEqual(["discord", "web"]);
  for (const value of ["", " ", "discord,", ",discord", "discord,discord", "../discord", "Discord"]) {
    expect(() => readSurfaceSelection(value)).toThrow();
  }
});

test("unsupported selection fails before importing any adapter", async () => {
  let imports = 0;
  const registry: SurfaceRegistry = new Map([["discord", async () => {
    imports++;
    throw new Error("must not import");
  }]]);
  await expect(prepareSurfaces({ SHEPHERD_SURFACES: "discord,web" }, registry)).rejects.toThrow("not available");
  expect(imports).toBe(0);
});

test("only selected adapters are configured, with isolated scope files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "surface-env-"));
  try {
    await mkdir(join(directory, "envs"));
    await writeFile(join(directory, "envs/alpha.env"), "KEY=alpha\nOTHER=alpha-only\n");
    await writeFile(join(directory, "envs/beta.env"), "KEY=beta\n");
    const values: unknown[] = [];
    let creations = 0;
    const registry: SurfaceRegistry = new Map(["alpha", "beta", "discord"].map((id) => [id, async () => ({
      configure(env) {
        if (id === "discord") throw new Error("disabled adapter imported");
        values.push([id, env.KEY, env.OTHER, env.COMMON]);
        return () => { creations++; return { async start() {}, stop() {} }; };
      },
    })]));
    const environment = { SHEPHERD_SURFACES: "alpha,beta", COMMON: "shared" };
    const prepared = await prepareSurfaces(environment, registry, directory);
    expect(prepared.map(({ id }) => id)).toEqual(["alpha", "beta"]);
    expect(values).toEqual([["alpha", "alpha", "alpha-only", "shared"], ["beta", "beta", undefined, "shared"]]);
    expect(environment).toEqual({ SHEPHERD_SURFACES: "alpha,beta", COMMON: "shared" });
    expect(creations).toBe(0);
    expect(readSurfaceEnvironment("alpha", { KEY: "inherited" }, directory).KEY).toBe("inherited");
    expect(() => readSurfaceEnvironment("../secret", {}, directory)).toThrow("Invalid");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("all selected configuration is validated before any client is created", async () => {
  let creates = 0;
  const registry: SurfaceRegistry = new Map([
    ["alpha", async () => ({ configure: () => () => { creates++; throw new Error("must not create"); } })],
    ["beta", async () => ({ configure: () => { throw new Error("missing beta credential"); } })],
  ]);
  await expect(prepareSurfaces({ SHEPHERD_SURFACES: "alpha,beta" }, registry)).rejects.toThrow("missing beta credential");
  expect(creates).toBe(0);
});

test("production registry validates web independently of Discord", async () => {
  await expect(prepareSurfaces({ SHEPHERD_SURFACES: "web" }, surfaceRegistry)).rejects.toThrow("SHEPHERD_WEB_TOKEN");
  expect((await prepareSurfaces({ SHEPHERD_SURFACES: "web", SHEPHERD_WEB_TOKEN: "a".repeat(64) }, surfaceRegistry)).map(({ id }) => id)).toEqual(["web"]);
  await expect(prepareSurfaces({ DISCORD_BOT_TOKEN: " " }, surfaceRegistry)).rejects.toThrow("Missing DISCORD_BOT_TOKEN");
  await expect(prepareSurfaces({ DISCORD_BOT_TOKEN: "test", SHEPHERD_DISCORD_STREAMING: "invalid" }, surfaceRegistry)).rejects.toThrow("must be true or false");
  expect((await prepareSurfaces({ DISCORD_BOT_TOKEN: "test" }, surfaceRegistry)).map(({ id }) => id)).toEqual(["discord"]);
});
