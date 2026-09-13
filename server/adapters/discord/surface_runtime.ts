import { createSurfaceRuntime, type SurfaceRuntimeOptions } from "../../runtime/surface_runtime.js";

export type DiscordSurfaceRuntimeOptions = Omit<SurfaceRuntimeOptions, "adapter">;

export function createDiscordSurfaceRuntime(options: DiscordSurfaceRuntimeOptions) {
  return createSurfaceRuntime({ ...options, adapter: "discord" });
}
