import type { SurfaceAdapter, SurfaceAdapterContext, SurfaceDefinition } from "../../runtime/surface_adapter.js";
import { readWebConfig, type WebConfig } from "./config.js";
import { WebSurfaceApi, WEB_MAX_BODY_BYTES } from "./api.js";
import { loadUiAssets, serveUiAsset, type UiAssets } from "./ui_assets.js";

type HttpServer = {
  hostname: string;
  port: number;
  timeout: (request: Request, seconds: number) => void;
  stop: (closeActiveConnections?: boolean) => void | Promise<void>;
};
export type WebServe = (options: {
  hostname: string;
  port: number;
  maxRequestBodySize: number;
  idleTimeout: number;
  fetch: (request: Request, server: HttpServer) => Promise<Response>;
}) => HttpServer;

export const webSurface: SurfaceDefinition = {
  configure(environment) {
    const config = readWebConfig(environment);
    return (context) => createWebAdapter(context, config);
  },
};

export function createWebAdapter(context: SurfaceAdapterContext, config: WebConfig, serve?: WebServe, assetsLoader: () => Promise<UiAssets> = loadUiAssets): SurfaceAdapter & { url: () => string | null } {
  const activeConfig = { ...config, origins: [...config.origins] };
  const api = new WebSurfaceApi(context, activeConfig);
  let allowedHosts = new Set<string>();
  let server: HttpServer | undefined;
  let stopped = false;
  let stopPromise: Promise<void> | undefined;
  let startPromise: Promise<void> | undefined;
  return {
    url: () => server ? `http://${server.hostname}:${server.port}` : null,
    start() {
      if (stopped || context.signal.aborted) return Promise.reject(new Error("Web adapter is stopping."));
      return startPromise ??= (async () => {
        if (stopped || context.signal.aborted) throw new Error("Web adapter is stopping.");
        if (server) return;
        if (config.hostname !== "127.0.0.1") throw new Error("Web API must bind to loopback.");
        const listen = serve ?? (globalThis as typeof globalThis & { Bun?: { serve: WebServe } }).Bun?.serve;
        if (!listen) throw new Error("Web API requires Bun.serve.");
        const assets = await assetsLoader();
        if (stopped || context.signal.aborted) throw new Error("Web adapter is stopping.");
        server = listen({
          hostname: config.hostname, port: config.port, maxRequestBodySize: WEB_MAX_BODY_BYTES, idleTimeout: 30,
          async fetch(request, listener) {
            const url = new URL(request.url);
            const origin = request.headers.get("origin");
            // Never derive trusted origins from Host or forwarded headers (DNS rebinding).
            if (!allowedHosts.has(url.host) || (origin !== null && !activeConfig.origins.includes(origin))) {
              return Response.json({ error: { code: "origin_denied", message: "Host or origin is not allowed." } }, { status: 403, headers: { "cache-control": "no-store" } });
            }
            if (context.isQuiescing() || stopped) return new Response(null, { status: 503 });
            const response = url.pathname.startsWith("/api/")
              ? await api.fetch(request)
              : serveUiAsset(request, assets);
            // Disable the idle timer only for accepted SSE streams.
            if (response.headers.get("content-type") === "text/event-stream") listener.timeout(request, 0);
            return response;
          },
        });
        activeConfig.origins = [...new Set([...config.origins, `http://127.0.0.1:${server.port}`, `http://localhost:${server.port}`])];
        allowedHosts = new Set(activeConfig.origins.map((origin) => new URL(origin).host));
        context.reportHealth({ state: "ready", detail: `listening on ${server.hostname}:${server.port}` });
      })();
    },
    stop() {
      return stopPromise ??= Promise.resolve().then(async () => {
        stopped = true;
        try { api.dispose(); }
        finally { const current = server; server = undefined; await current?.stop(true); }
      });
    },
    async presentSignal(signal) { api.presentSignal(signal); },
  };
}
