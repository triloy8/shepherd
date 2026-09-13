import { startWebhookSignalServer, type WebhookSignalServer } from "../adapters/webhook/server.js";
import type { SignalRuntimeConfig } from "../config/signal_environment.js";
import { ConversationSignalExecutor } from "../core/conversation_signal_executor.js";
import { SignalDispatcher, type SignalDispatcherOptions } from "../core/signal_dispatcher.js";
import { SignalRegistry } from "../core/signal_registry.js";
import { SignalRouteRegistry } from "../core/signal_route_registry.js";
import { SignalRouteService } from "../core/signal_route_service.js";
import { createResearchStateChangedDefinition } from "../signals/research_state_changed.js";
import type { ShepherdRuntime } from "./shepherd_runtime.js";

export type SignalRuntimeOptions = {
  config: SignalRuntimeConfig;
  registry?: SignalRegistry;
  beforeExecute?: SignalDispatcherOptions["beforeExecute"];
  startServer?: typeof startWebhookSignalServer;
};

/** Process-owned signal infrastructure; surfaces supply only delivery hooks. */
export class SignalRuntime {
  private server: WebhookSignalServer | null = null;
  private readonly registry: SignalRegistry;
  private readonly routes: SignalRouteRegistry;
  private readonly dispatcher: SignalDispatcher;
  private readonly unregisterTool: () => void;
  private stopPromise: Promise<void> | null = null;

  constructor(private readonly shepherd: ShepherdRuntime, private readonly options: SignalRuntimeOptions) {
    this.registry = options.registry ?? new SignalRegistry();
    if (!options.registry) this.registry.register(createResearchStateChangedDefinition());
    this.routes = new SignalRouteRegistry({
      onEvent: (event) => console.info(`signal route ${event.type}: ${event.routePrefix} (${event.kind}@${event.version})`),
    });
    const routeService = new SignalRouteService({
      routes: this.routes,
      signals: this.registry,
      conversation: shepherd.conversation,
      getWebhookBaseUrl: () => this.server?.url ?? null,
    });
    this.dispatcher = new SignalDispatcher(new ConversationSignalExecutor(shepherd.conversation), {
      capacity: options.config.queueCapacity,
      beforeExecute: options.beforeExecute,
    });
    this.unregisterTool = options.config.enabled
      ? shepherd.conversation.registerDynamicTool(routeService.registration())
      : () => {};
    shepherd.registerShutdownHook(() => this.stop());
  }

  get url(): string | null {
    return this.server?.url ?? null;
  }

  start(): void {
    if (this.stopPromise || this.shepherd.isQuiescing()) throw new Error("Signal runtime is stopping.");
    if (!this.options.config.enabled || this.server) return;
    const { hostname, port, maxBodyBytes } = this.options.config;
    this.server = (this.options.startServer ?? startWebhookSignalServer)({
      registry: this.registry,
      routes: this.routes,
      dispatcher: this.dispatcher,
      hostname, port, maxBodyBytes,
      isAvailable: () => !this.stopPromise && !this.shepherd.isQuiescing(),
    });
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    // Defer cleanup so the guard is installed even when a shutdown operation throws.
    this.stopPromise = Promise.resolve().then(async () => {
      this.unregisterTool();
      this.routes.dispose();
      this.dispatcher.dispose();
      const server = this.server;
      this.server = null;
      await server?.stop();
    });
    return this.stopPromise;
  }
}
