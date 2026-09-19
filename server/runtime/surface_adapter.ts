import type { ApprovalPolicy } from "../../shared/protocol/requests.js";
import type { BridgeEvent } from "../../shared/protocol/events.js";
import type { SurfaceApplicationContext } from "../core/surface_application_context.js";
import type { ApprovalConversation, InteractionConversation } from "../core/conversation_ports.js";
import type { TurnRoutingConversation } from "../core/turn_routing_service.js";
import type { RegisteredSignal } from "../core/signal_registry.js";

export type SurfaceHealth = {
  state: "starting" | "ready" | "degraded" | "stopped";
  detail?: string;
};

/** Surface-scoped capabilities. No process ownership or raw runtime access. */
export type SurfaceAdapterContext = {
  signal: AbortSignal;
  approvalPolicy: ApprovalPolicy;
  ingress: TurnRoutingConversation;
  interactions: InteractionConversation;
  approvals: ApprovalConversation;
  createApplication: (onThreadEvent: (surfaceId: string, event: BridgeEvent) => void) => SurfaceApplicationContext;
  isQuiescing: () => boolean;
  reportHealth: (health: SurfaceHealth) => void;
};

export type SurfaceAdapter = {
  start: () => Promise<void>;
  stop: () => void | Promise<void>;
  presentSignal?: (signal: RegisteredSignal) => Promise<void>;
};

export type PreparedSurface = {
  id: string;
  create: (context: SurfaceAdapterContext) => SurfaceAdapter;
};

export type SurfaceDefinition = {
  /** Validate configuration without starting clients or opening listeners. */
  configure: (environment: Record<string, string | undefined>) => PreparedSurface["create"];
};
