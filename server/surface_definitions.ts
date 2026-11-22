import type { SurfaceRegistry } from "./runtime/surface_registry.js";

// Production composition belongs at the root; shared runtime knows no transport.
// Register only implemented adapters and import only those selected at launch.
export const surfaceRegistry: SurfaceRegistry = new Map([
  ["web", async () => {
    const [{ createWebSurface }, { FileSwarmStore }] = await Promise.all([
      import("./adapters/web/server.js"), import("./storage/swarm_store.js"),
    ]);
    return createWebSurface(directory => new FileSwarmStore(directory));
  }],
  ["discord", () => import("./adapters/discord/bot.js").then((module) => module.discordSurface)],
]);
