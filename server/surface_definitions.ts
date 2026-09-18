import type { SurfaceRegistry } from "./runtime/surface_registry.js";

// Production composition belongs at the root; shared runtime knows no transport.
// Register only implemented adapters and import only those selected at launch.
export const surfaceRegistry: SurfaceRegistry = new Map([
  ["discord", () => import("./adapters/discord/bot.js").then((module) => module.discordSurface)],
]);
