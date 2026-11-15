import { WEB_MESSAGE_MAX_BODY_BYTES } from "./browser_image_input.js";
import type { SurfaceAdapter, SurfaceAdapterContext } from "../../core/surface_api.js";
import type { WebConfig } from "./browser_config.js";
import { WebSurfaceApi } from "./browser_api.js";
import { loadUiAssets, serveUiAsset, type UiAssets } from "./browser_ui_assets.js";

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

export function createWebAdapter(context: SurfaceAdapterContext, config: WebConfig, serve?: WebServe, assetsLoader: () => Promise<UiAssets> = loadUiAssets,
  options: { index?: string; createApi?: (config: WebConfig) => Pick<WebSurfaceApi, "fetch" | "dispose" | "presentSignal"> } = {},
): SurfaceAdapter & { url: () => string | null } {
  const activeConfig = { ...config, origins: [...config.origins] };
  const api = options.createApi?.(activeConfig) ?? new WebSurfaceApi(context, activeConfig);
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
        if (!assets.has(options.index ?? "/index.html")) throw new Error("Browser UI entry is missing. Run bun run build.");
        if (stopped || context.signal.aborted) throw new Error("Web adapter is stopping.");
        server = listen({
          hostname: config.hostname, port: config.port, maxRequestBodySize: WEB_MESSAGE_MAX_BODY_BYTES, idleTimeout: 30,
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
              : serveUiAsset(request, assets, options.index);
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
        const current = server; server = undefined;
        // Cancel HTTP streams before disposing their controllers. Bun can leave
        // stop(true) pending when completed SSE responses still have queued data.
        const closing = (async () => { await current?.stop(true); })();
        const results = await Promise.allSettled([closing, Promise.resolve().then(() => api.dispose())]);
        const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
        if (failures.length) throw new AggregateError(failures, "Browser adapter cleanup failed.");
      });
    },
    async presentSignal(signal) { api.presentSignal(signal); },
  };
}
