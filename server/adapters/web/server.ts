import type { SurfaceDefinition } from "../../core/surface_api.js";
import { readWebConfig } from "../shared/browser_config.js";
import { createWebAdapter } from "../shared/browser_server.js";

export const webSurface: SurfaceDefinition = {
  configure(environment) {
    const config = readWebConfig(environment);
    return (context) => createWebAdapter(context, config);
  },
};
