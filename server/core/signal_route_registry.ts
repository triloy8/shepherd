import { randomBytes } from "node:crypto";

import {
  assertSignalTarget,
  parseSignalEnvelope,
  type SignalTarget,
} from "./signal_registry.js";

const HOUR_MS = 60 * 60 * 1000;

export const DEFAULT_SIGNAL_ROUTE_TTL_MS = 24 * HOUR_MS;
export const MAX_SIGNAL_ROUTE_TTL_MS = 7 * 24 * HOUR_MS;
export const DEFAULT_SIGNAL_ROUTE_CAPACITY = 1_000;
export const DEFAULT_SIGNAL_ROUTE_REQUESTS_PER_MINUTE = 60;

export type SignalRoute = {
  id: string;
  allowedSignal: {
    kind: string;
    version: number;
  };
  target: SignalTarget;
  originTurnId: string;
  createdAt: number;
  expiresAt: number;
};

type StoredSignalRoute = SignalRoute & {
  rateWindowStartedAt: number;
  requestCount: number;
  rateLimitReported: boolean;
};

export type CreateSignalRouteRequest = {
  allowedSignal: SignalRoute["allowedSignal"];
  target: SignalTarget;
  originTurnId: string;
  ttlMs?: number;
};

export type SignalRouteRegistryOptions = {
  capacity?: number;
  defaultTtlMs?: number;
  maxTtlMs?: number;
  requestsPerMinute?: number;
  now?: () => number;
  generateId?: () => string;
  onEvent?: (event: SignalRouteEvent) => void;
};

export type SignalRouteEvent = {
  type: "created" | "expired" | "revoked" | "rate-limited";
  routePrefix: string;
  kind: string;
  version: number;
};

export class SignalRouteCapacityError extends Error {}
export class SignalRouteRateLimitError extends Error {}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function publicRoute(route: StoredSignalRoute): SignalRoute {
  return {
    id: route.id,
    allowedSignal: { ...route.allowedSignal },
    target: {
      ...route.target,
      delivery: { ...route.target.delivery },
    },
    originTurnId: route.originTurnId,
    createdAt: route.createdAt,
    expiresAt: route.expiresAt,
  };
}

export class SignalRouteRegistry {
  private readonly routes = new Map<string, StoredSignalRoute>();
  private readonly capacity: number;
  private readonly defaultTtlMs: number;
  private readonly maxTtlMs: number;
  private readonly requestsPerMinute: number;
  private readonly now: () => number;
  private readonly generateId: () => string;
  private readonly onEvent: (event: SignalRouteEvent) => void;
  private disposed = false;

  constructor(options: SignalRouteRegistryOptions = {}) {
    this.capacity = positiveInteger(
      options.capacity ?? DEFAULT_SIGNAL_ROUTE_CAPACITY,
      "Signal route capacity",
    );
    this.defaultTtlMs = positiveInteger(
      options.defaultTtlMs ?? DEFAULT_SIGNAL_ROUTE_TTL_MS,
      "Default signal route TTL",
    );
    this.maxTtlMs = positiveInteger(
      options.maxTtlMs ?? MAX_SIGNAL_ROUTE_TTL_MS,
      "Maximum signal route TTL",
    );
    if (this.defaultTtlMs > this.maxTtlMs) {
      throw new Error("Default signal route TTL cannot exceed the maximum TTL.");
    }
    this.requestsPerMinute = positiveInteger(
      options.requestsPerMinute ?? DEFAULT_SIGNAL_ROUTE_REQUESTS_PER_MINUTE,
      "Signal route requests per minute",
    );
    this.now = options.now ?? Date.now;
    this.generateId = options.generateId ?? (() => randomBytes(32).toString("base64url"));
    this.onEvent = options.onEvent ?? (() => {});
  }

  create(request: CreateSignalRouteRequest): SignalRoute {
    if (this.disposed) throw new Error("Signal route registry is disposed.");
    const now = this.now();
    this.pruneExpired(now);
    if (this.routes.size >= this.capacity) {
      throw new SignalRouteCapacityError("Signal route capacity is exhausted.");
    }

    const ttlMs = request.ttlMs ?? this.defaultTtlMs;
    positiveInteger(ttlMs, "Signal route TTL");
    if (ttlMs > this.maxTtlMs) {
      throw new Error("Signal route TTL exceeds the maximum lifetime.");
    }
    const allowedSignal = parseSignalEnvelope({
      kind: request.allowedSignal.kind,
      version: request.allowedSignal.version,
      payload: null,
    });
    if (!request.originTurnId.trim() || request.originTurnId !== request.originTurnId.trim()) {
      throw new Error("Signal route origin turn must be a non-empty trimmed string.");
    }
    assertSignalTarget(request.target);

    let id = "";
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = this.generateId();
      if (!/^[A-Za-z0-9_-]{20,128}$/.test(candidate)) {
        throw new Error("Signal route generator produced an invalid identifier.");
      }
      if (!this.routes.has(candidate)) {
        id = candidate;
        break;
      }
    }
    if (!id) throw new Error("Could not allocate a unique signal route identifier.");

    const route: StoredSignalRoute = {
      id,
      allowedSignal: { kind: allowedSignal.kind, version: allowedSignal.version },
      target: {
        ...request.target,
        delivery: { ...request.target.delivery },
      },
      originTurnId: request.originTurnId,
      createdAt: now,
      expiresAt: now + ttlMs,
      rateWindowStartedAt: now,
      requestCount: 0,
      rateLimitReported: false,
    };
    this.routes.set(id, route);
    this.emit("created", route);
    return publicRoute(route);
  }

  consume(id: string): SignalRoute | null {
    if (this.disposed) return null;
    const now = this.now();
    const route = this.routes.get(id);
    if (!route) return null;
    if (route.expiresAt <= now) {
      this.routes.delete(id);
      this.emit("expired", route);
      return null;
    }

    if (now - route.rateWindowStartedAt >= 60_000) {
      route.rateWindowStartedAt = now;
      route.requestCount = 0;
      route.rateLimitReported = false;
    }
    if (route.requestCount >= this.requestsPerMinute) {
      if (!route.rateLimitReported) {
        route.rateLimitReported = true;
        this.emit("rate-limited", route);
      }
      throw new SignalRouteRateLimitError("Signal route request rate exceeded.");
    }
    route.requestCount += 1;
    return publicRoute(route);
  }

  revoke(id: string): boolean {
    const route = this.routes.get(id);
    if (!route) return false;
    this.routes.delete(id);
    this.emit("revoked", route);
    return true;
  }

  size(): number {
    if (!this.disposed) this.pruneExpired(this.now());
    return this.routes.size;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.routes.clear();
  }

  private pruneExpired(now: number): void {
    for (const [id, route] of this.routes) {
      if (route.expiresAt <= now) {
        this.routes.delete(id);
        this.emit("expired", route);
      }
    }
  }

  private emit(type: SignalRouteEvent["type"], route: SignalRoute): void {
    try {
      this.onEvent({
        type,
        routePrefix: route.id.slice(0, 8),
        kind: route.allowedSignal.kind,
        version: route.allowedSignal.version,
      });
    } catch {
      // Diagnostics must not affect callback routing.
    }
  }
}
