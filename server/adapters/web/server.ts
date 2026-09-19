import type { SurfaceAdapter, SurfaceAdapterContext, SurfaceDefinition } from "../../runtime/surface_adapter.js";
import { readWebConfig, type WebConfig } from "./config.js";
import { WebSurfaceApi, WEB_MAX_BODY_BYTES } from "./api.js";

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

export function createWebAdapter(context: SurfaceAdapterContext, config: WebConfig, serve?: WebServe): SurfaceAdapter & { url: () => string | null } {
  const api = new WebSurfaceApi(context, config);
  let server: HttpServer | undefined;
  let stopped = false;
  let stopPromise: Promise<void> | undefined;
  return {
    url: () => server ? `http://${server.hostname}:${server.port}` : null,
    async start() {
      if (stopped || context.signal.aborted) throw new Error("Web adapter is stopping.");
      if (server) return;
      if (config.hostname !== "127.0.0.1") throw new Error("Web API must bind to loopback.");
      const listen = serve ?? (globalThis as typeof globalThis & { Bun?: { serve: WebServe } }).Bun?.serve;
      if (!listen) throw new Error("Web API requires Bun.serve.");
      server = listen({
        hostname: config.hostname, port: config.port, maxRequestBodySize: WEB_MAX_BODY_BYTES, idleTimeout: 30,
        async fetch(request, listener) {
          const response = await api.fetch(request);
          // Disable the idle timer only for accepted SSE streams.
          if (response.headers.get("content-type") === "text/event-stream") listener.timeout(request, 0);
          return response;
        },
      });
      context.reportHealth({ state: "ready", detail: `listening on ${server.hostname}:${server.port}` });
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
