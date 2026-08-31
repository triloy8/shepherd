import type {
  DynamicToolCallParams,
  DynamicToolCallResponse,
  JsonValue,
} from "../../shared/protocol/dynamic_tools.js";
import type { GetThreadStateResponse } from "../../shared/protocol/requests.js";
import type { ConversationSurface } from "./conversation_routing_service.js";
import type { DynamicToolRegistration } from "./dynamic_tool_registry.js";
import {
  SignalRouteCapacityError,
  type SignalRouteRegistry,
} from "./signal_route_registry.js";
import { parseSignalEnvelope, type SignalRegistry } from "./signal_registry.js";

const ARGUMENT_KEYS = new Set(["kind", "version"]);

type SignalRouteConversation = {
  getThreadState: (threadId: string) => GetThreadStateResponse;
  getThreadCwd: (threadId: string) => Promise<string>;
  getThreadSurface: (threadId: string) => ConversationSurface | null;
};

export type SignalRouteServiceOptions = {
  routes: SignalRouteRegistry;
  signals: SignalRegistry;
  conversation: SignalRouteConversation;
  getWebhookBaseUrl: () => string | null;
};

function isRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function failed(message: string): DynamicToolCallResponse {
  return {
    success: false,
    contentItems: [{ type: "inputText", text: message }],
  };
}

function parseArguments(value: JsonValue): { kind: string; version: number } {
  if (!isRecord(value)) throw new Error("Callback tool arguments must be an object.");
  const unknown = Object.keys(value).find((key) => !ARGUMENT_KEYS.has(key));
  if (unknown) throw new Error(`Unknown callback tool argument: ${unknown}.`);
  const envelope = parseSignalEnvelope({
    kind: value.kind,
    version: value.version,
    payload: null,
  });
  return { kind: envelope.kind, version: envelope.version };
}

function callbackUrl(baseUrl: string, routeId: string): string {
  return `${baseUrl.replace(/\/$/, "")}/signals/${encodeURIComponent(routeId)}`;
}

export class SignalRouteService {
  constructor(private readonly options: SignalRouteServiceOptions) {}

  registration(): DynamicToolRegistration {
    return {
      namespace: "shepherd",
      namespaceDescription: "Services supplied by the Shepherd conversation bridge.",
      name: "get_signal_callback",
      description:
        "Create a unique localhost callback URL immediately before launching a detached local service. Pass the returned URL to that service with its --signal-url CLI argument.",
      inputSchema: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            description: "Registered versioned signal kind the detached service will send.",
          },
          version: {
            type: "integer",
            minimum: 1,
            description: "Registered signal schema version.",
          },
        },
        required: ["kind", "version"],
        additionalProperties: false,
      },
      execute: (params) => this.execute(params),
    };
  }

  private async execute(params: DynamicToolCallParams): Promise<DynamicToolCallResponse> {
    let requested: { kind: string; version: number };
    try {
      requested = parseArguments(params.arguments);
    } catch (error) {
      return failed(error instanceof Error ? error.message : "Invalid callback tool arguments.");
    }

    if (!this.options.signals.has(requested.kind, requested.version)) {
      return failed(`Unsupported signal definition: ${requested.kind}@${requested.version}.`);
    }

    let state: GetThreadStateResponse;
    try {
      state = this.options.conversation.getThreadState(params.threadId);
    } catch {
      return failed("The originating Codex thread is unavailable.");
    }
    if (state.activeTurnId !== params.turnId) {
      return failed("The callback request no longer belongs to the active turn.");
    }

    const surface = this.options.conversation.getThreadSurface(params.threadId);
    if (!surface) {
      return failed("The originating delivery surface is unavailable.");
    }
    const baseUrl = this.options.getWebhookBaseUrl();
    if (!baseUrl) {
      return failed("The Shepherd signal webhook is unavailable.");
    }

    try {
      const route = this.options.routes.create({
        allowedSignal: requested,
        originTurnId: params.turnId,
        target: {
          type: "conversation",
          threadId: params.threadId,
          cwd: await this.options.conversation.getThreadCwd(params.threadId),
          delivery: surface,
        },
      });
      return {
        success: true,
        contentItems: [
          {
            type: "inputText",
            text: JSON.stringify({ url: callbackUrl(baseUrl, route.id) }),
          },
        ],
      };
    } catch (error) {
      if (error instanceof SignalRouteCapacityError) {
        return failed("Shepherd cannot allocate another callback route right now.");
      }
      throw error;
    }
  }
}
