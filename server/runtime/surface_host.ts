import { swarmManagerRegistrations } from "../core/surface/swarm_manager_tools.js";
import type { RuntimeConfig } from "../config/runtime_environment.js";
import { createApprovalConversation, createIngressConversation, createInteractionConversation } from "../core/surface/conversation_ports.js";
import { createHostRuntime } from "./host_runtime.js";
import { SignalRuntime } from "./signal_runtime.js";
import { createSurfaceRuntime } from "./surface_runtime.js";
import type { PreparedSurface, SurfaceAdapter, SurfaceHealth } from "../core/surface_api.js";

type SignalPresenter = NonNullable<SurfaceAdapter["presentSignal"]>;
type HostSignals = Pick<SignalRuntime, "start" | "stop" | "url"> & Partial<Pick<SignalRuntime, "watchSwarm">>;

export type SurfaceHostOptions = {
  config: RuntimeConfig;
  surfaces: PreparedSurface[];
  projectDir?: string;
  createHost?: typeof createHostRuntime;
  createSignals?: (
    host: ReturnType<typeof createHostRuntime>,
    beforeExecute: SignalPresenter,
  ) => HostSignals;
  onHealth?: (surface: string, health: SurfaceHealth) => void;
};

/** One process host; all adapters share its conversation and lifecycle services. */
export function createSurfaceHost(options: SurfaceHostOptions) {
  if (!options.surfaces.length || new Set(options.surfaces.map(({ id }) => id)).size !== options.surfaces.length) {
    throw new Error("Select at least one surface, with no duplicates.");
  }
  const host = (options.createHost ?? createHostRuntime)({ config: options.config, projectDir: options.projectDir });
  const { shepherd, config, workspace } = host;
  const abort = new AbortController();
  shepherd.registerShutdownHook(() => abort.abort());
  const adapters = new Map<string, SurfaceAdapter>();
  const health = new Map<string, SurfaceHealth>();
  let startPromise: Promise<void> | undefined;
  const report = (id: string, value: SurfaceHealth) => {
    if (shepherd.isQuiescing() && value.state !== "stopped") return;
    health.set(id, { ...value });
    if (options.onHealth) options.onHealth(id, { ...value });
    else console.info(`surface ${id}: ${value.state}${value.detail ? ` (${value.detail})` : ""}`);
  };
  const beforeExecute: SignalPresenter = async (signal) => {
    const id = signal.target.delivery.adapter;
    try {
      await adapters.get(id)?.presentSignal?.(signal);
    } catch (error) {
      // Presentation failure must not discard the signal's actual work.
      console.error(`Surface ${id} signal notice delivery failed:`, error);
    }
  };
  let signals: HostSignals | undefined;
  // Stop ingress before adapters, then ShepherdRuntime stops conversations.
  shepherd.registerShutdownHook(async () => { await signals?.stop(); });

  async function start() {
    try {
      if (shepherd.isQuiescing()) throw new Error("Shepherd is stopping.");
      signals = options.createSignals
        ? options.createSignals(host, beforeExecute)
        : new SignalRuntime(shepherd, { config: config.signals, beforeExecute });
      for (const prepared of options.surfaces) {
        if (shepherd.isQuiescing()) throw new Error("Shepherd is stopping.");
        report(prepared.id, { state: "starting" });
        const adapter = prepared.create({
          ...(prepared.id === "web" ? { swarmManager: {
            connect: (handler: import("../ports/swarm_runtime.js").SwarmManagerHandler) => {
              const unregister = swarmManagerRegistrations(handler).map(tool => shepherd.conversation.registerDynamicTool(tool));
              return () => { for (const remove of unregister) remove(); };
            },
            watch: (params: import("../../shared/protocol/dynamic_tools.js").DynamicToolCallParams, group: string, threads: Array<{ threadId: string; label: string }>) => {
              if (!signals?.watchSwarm) throw new Error("Worker notification service is unavailable.");
              return signals.watchSwarm(params, group, threads);
            },
          } } : {}),
          signal: abort.signal,
          ingress: createIngressConversation(shepherd.conversation),
          interactions: createInteractionConversation(shepherd.conversation),
          approvals: createApprovalConversation(shepherd.conversation),
          isQuiescing: () => shepherd.isQuiescing(),
          reportHealth: (value) => report(prepared.id, value),
          createApplication: (onThreadEvent) => createSurfaceRuntime({
            adapter: prepared.id,
            conversation: shepherd.conversation,
            runtimeLifecycle: shepherd.lifecycle,
            onThreadEvent,
            ...workspace,
          }).commandContext,
        });
        adapters.set(prepared.id, adapter);
        shepherd.registerShutdownHook(async () => {
          try { await adapter.stop(); }
          finally { report(prepared.id, { state: "stopped" }); }
        });
        await adapter.start();
        if (shepherd.isQuiescing()) throw new Error("Shepherd stopped during surface startup.");
        if (health.get(prepared.id)?.state === "starting") report(prepared.id, { state: "ready" });
      }
      signals.start();
      if (signals.url) console.info(`signal webhook ready at ${signals.url}`);
    } catch (error) {
      try { await shepherd.shutdown(); }
      catch (cleanupError) { console.error("Shepherd startup cleanup failed:", cleanupError); }
      throw error;
    }
  }

  return {
    start: () => startPromise ??= start(),
    stop: () => shepherd.shutdown(),
    health: () => Object.fromEntries([...health].map(([id, value]) => [id, { ...value }])),
  };
}
