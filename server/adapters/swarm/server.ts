import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import type { SurfaceDefinition, SurfaceAdapterContext } from "../../core/surface_api.js";
import type { SwarmStore } from "../../ports/swarm_store.js";
import { readWebConfig, type WebConfig } from "../shared/browser_config.js";
import { createWebAdapter, type WebServe } from "../shared/browser_server.js";
import { loadUiAssets, type UiAssets } from "../shared/browser_ui_assets.js";
import { SwarmSurfaceApi } from "./api.js";

export function createSwarmSurface(store: (directory: string) => SwarmStore): SurfaceDefinition {
  return { configure(environment) {
    let config: WebConfig;
    try { config = readWebConfig({ SHEPHERD_WEB_PORT: environment.SHEPHERD_SWARM_PORT ?? "8789", SHEPHERD_WEB_ORIGINS: environment.SHEPHERD_SWARM_ORIGINS }); }
    catch (error) { throw new Error((error as Error).message.replaceAll("SHEPHERD_WEB_", "SHEPHERD_SWARM_")); }
    const directory = environment.SHEPHERD_SWARM_STATE_DIR ?? join(homedir(), ".shepherd", "swarm-groups");
    if (!isAbsolute(directory)) throw new Error("SHEPHERD_SWARM_STATE_DIR must be an absolute path.");
    return context => createSwarmAdapter(context, config, store(directory));
  } };
}
export function createSwarmAdapter(context: SurfaceAdapterContext, config: WebConfig, store: SwarmStore, serve?: WebServe, assetsLoader: () => Promise<UiAssets> = loadUiAssets) {
  return createWebAdapter(context, config, serve, assetsLoader, { index: "/swarm.html", createApi: activeConfig => new SwarmSurfaceApi(context, activeConfig, store) });
}
