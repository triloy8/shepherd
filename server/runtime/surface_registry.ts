import { readSurfaceEnvironment } from "../config/environment.js";
import type { PreparedSurface, SurfaceDefinition } from "./surface_adapter.js";

export type SurfaceRegistry = ReadonlyMap<string, () => Promise<SurfaceDefinition>>;

export function readSurfaceSelection(value: string | undefined): string[] {
  if (value === undefined) return ["discord"];
  const names = value.split(",").map((name) => name.trim());
  if (names.some((name) => !/^[a-z][a-z0-9-]*$/.test(name))) {
    throw new Error("SHEPHERD_SURFACES must be a non-empty comma-separated list of surface names.");
  }
  if (new Set(names).size !== names.length) throw new Error("SHEPHERD_SURFACES contains duplicate surfaces.");
  return names;
}

export async function prepareSurfaces(
  environment: Record<string, string | undefined> = process.env,
  registry: SurfaceRegistry,
  projectDir = process.cwd(),
): Promise<PreparedSurface[]> {
  const names = readSurfaceSelection(environment.SHEPHERD_SURFACES);
  for (const name of names) {
    if (!registry.has(name)) {
      throw new Error(`Surface '${name}' is not available. Available surfaces: ${[...registry.keys()].join(", ")}.`);
    }
  }
  const prepared: PreparedSurface[] = [];
  for (const id of names) {
    const definition = await registry.get(id)!();
    prepared.push({ id, create: definition.configure(readSurfaceEnvironment(id, environment, projectDir)) });
  }
  return prepared;
}
