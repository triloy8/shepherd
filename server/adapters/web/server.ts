import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import type { SurfaceDefinition, SurfaceAdapterContext } from "../../core/surface_api.js";
import type { SwarmStore } from "../../ports/swarm_store.js";
import { readWebConfig, type WebConfig } from "../shared/browser_config.js";
import { createWebAdapter, type WebServe } from "../shared/browser_server.js";
import { loadUiAssets, type UiAssets } from "../shared/browser_ui_assets.js";
import { WebChatApi } from "./api.js";

export function createWebSurface(store: (directory: string) => SwarmStore): SurfaceDefinition {
  return { configure(environment) {
    const config = readWebConfig(environment);
    const directory = environment.SHEPHERD_SWARM_STATE_DIR ?? join(homedir(), ".shepherd", "swarm-groups");
    if (!isAbsolute(directory)) throw new Error("SHEPHERD_SWARM_STATE_DIR must be an absolute path.");
    return context => createWebChatAdapter(context, config, store(directory));
  } };
}
export function createWebChatAdapter(context: SurfaceAdapterContext, config: WebConfig, store: SwarmStore, serve?: WebServe, assetsLoader: () => Promise<UiAssets> = loadUiAssets) {
  return createWebAdapter(context, config, serve, assetsLoader, { createApi: activeConfig => new WebChatApi(context, activeConfig, store) });
}
