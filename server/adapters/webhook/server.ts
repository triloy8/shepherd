import type { SignalDispatchResult } from "../../core/signal_dispatcher.js";
import {
  InvalidSignalError,
  UnknownSignalKindError,
  UnsupportedSignalVersionError,
  type RegisteredSignal,
} from "../../core/signal_registry.js";

const DEFAULT_HOSTNAME = "127.0.0.1";
const DEFAULT_PORT = 8787;
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

type SignalResolver = {
  resolve: (value: unknown) => RegisteredSignal;
};

type SignalAcceptor = {
  accept: (signal: RegisteredSignal) => Promise<SignalDispatchResult>;
};

type BunServer = {
  hostname: string;
  port: number;
  stop: (closeActiveConnections?: boolean) => void | Promise<void>;
};

type BunServe = (options: {
  hostname: string;
  port: number;
  fetch: (request: Request) => Response | Promise<Response>;
}) => BunServer;

export type WebhookSignalServerOptions = {
  registry: SignalResolver;
  dispatcher: SignalAcceptor;
  hostname?: string;
  port?: number;
  maxBodyBytes?: number;
  allowNonLoopback?: boolean;
  isAvailable?: () => boolean;
  onError?: (error: unknown) => void;
  serve?: BunServe;
};

export type WebhookSignalServer = {
  hostname: string;
  port: number;
  url: string;
  stop: () => Promise<void>;
};

class BodyTooLargeError extends Error {}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
    },
  });
}

async function readBoundedJson(request: Request, maxBodyBytes: number): Promise<unknown> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (Number.isFinite(parsedLength) && parsedLength > maxBodyBytes) {
      throw new BodyTooLargeError("Signal body is too large.");
    }
  }

  if (!request.body) throw new SyntaxError("Signal body is required.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBodyBytes) {
      await reader.cancel();
      throw new BodyTooLargeError("Signal body is too large.");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  if (!text.trim()) throw new SyntaxError("Signal body is required.");
  return JSON.parse(text) as unknown;
}

function responseForDispatch(result: SignalDispatchResult): Response {
  switch (result.type) {
    case "accepted":
      return jsonResponse(202, { accepted: true, coalesced: false, threadId: result.threadId });
    case "coalesced":
      return jsonResponse(202, { accepted: true, coalesced: true, threadId: result.threadId });
    case "saturated":
      return jsonResponse(429, { error: "Signal queue is full." });
    case "target-unavailable":
      return jsonResponse(409, { error: "Signal target has no active thread binding." });
    case "unavailable":
      return jsonResponse(503, { error: "Shepherd is not accepting signals." });
  }
}

export function startWebhookSignalServer(options: WebhookSignalServerOptions): WebhookSignalServer {
  const hostname = options.hostname ?? DEFAULT_HOSTNAME;
  if (!options.allowNonLoopback && !LOOPBACK_HOSTS.has(hostname)) {
    throw new Error(`Webhook signal server must bind to loopback, received: ${hostname}.`);
  }

  const port = options.port ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("Webhook signal server port must be an integer from 0 to 65535.");
  }

  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1) {
    throw new Error("Webhook signal body limit must be a positive integer.");
  }

  const isAvailable = options.isAvailable ?? (() => true);
  const onError = options.onError ?? ((error: unknown) => console.error("Webhook signal failed:", error));
  const serve = options.serve ?? (globalThis as typeof globalThis & { Bun?: { serve: BunServe } }).Bun?.serve;
  if (!serve) throw new Error("Webhook signal server requires Bun.serve.");

  const server = serve({
    hostname,
    port,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        return isAvailable()
          ? jsonResponse(200, { ok: true })
          : jsonResponse(503, { ok: false });
      }
      if (request.method !== "POST" || url.pathname !== "/signals") {
        return jsonResponse(404, { error: "Not found." });
      }
      if (!isAvailable()) {
        return jsonResponse(503, { error: "Shepherd is not accepting signals." });
      }
      const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (contentType !== "application/json") {
        return jsonResponse(415, { error: "Content-Type must be application/json." });
      }

      try {
        const value = await readBoundedJson(request, maxBodyBytes);
        const signal = options.registry.resolve(value);
        return responseForDispatch(await options.dispatcher.accept(signal));
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          return jsonResponse(413, { error: error.message });
        }
        if (error instanceof UnknownSignalKindError) {
          return jsonResponse(404, { error: error.message });
        }
        if (
          error instanceof InvalidSignalError ||
          error instanceof UnsupportedSignalVersionError ||
          error instanceof SyntaxError
        ) {
          return jsonResponse(400, { error: error instanceof Error ? error.message : "Invalid signal." });
        }
        onError(error);
        return jsonResponse(500, { error: "Signal handling failed." });
      }
    },
  });

  const displayHostname = server.hostname.includes(":") ? `[${server.hostname}]` : server.hostname;
  return {
    hostname: server.hostname,
    port: server.port,
    url: `http://${displayHostname}:${server.port}`,
    stop: async () => {
      await server.stop(true);
    },
  };
}
