import { loadCommonEnvironment } from "./config/environment.js";
import { readRuntimeConfig } from "./config/runtime_environment.js";
import { surfaceRegistry } from "./surface_definitions.js";
import { prepareSurfaces } from "./runtime/surface_registry.js";
import { createSurfaceHost } from "./runtime/surface_host.js";
import { installShutdownHandlers } from "./runtime/process_lifecycle.js";

async function main(): Promise<void> {
  loadCommonEnvironment();
  const config = readRuntimeConfig();
  const surfaces = await prepareSurfaces(process.env, surfaceRegistry);
  // Complete all config validation before creating a runtime or opening clients.
  if (process.argv.includes("--check-config")) {
    console.info(`Shepherd configuration valid. Selected surfaces: ${surfaces.map(({ id }) => id).join(", ")}`);
    return;
  }
  const host = createSurfaceHost({ config, surfaces });
  const removeHandlers = installShutdownHandlers(host.stop);
  try { await host.start(); }
  catch (error) { removeHandlers(); throw error; }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
