import type { SurfaceRegistry } from "./runtime/surface_registry.js";

// Production composition belongs at the root; shared runtime knows no transport.
// Register only implemented adapters and import only those selected at launch.
export const surfaceRegistry: SurfaceRegistry = new Map([
  ["web", () => import("./adapters/web/server.js").then((module) => module.webSurface)],
  ["swarm", async () => {
    const [{ createSwarmSurface }, { FileSwarmStore }] = await Promise.all([
      import("./adapters/swarm/server.js"), import("./storage/swarm_store.js"),
    ]);
    return createSwarmSurface(directory => new FileSwarmStore(directory));
  }],
  ["discord", () => import("./adapters/discord/bot.js").then((module) => module.discordSurface)],
]);
