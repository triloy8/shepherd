/** Core's front door for surfaces: the contract a surface implements and receives, and the core
 * services and errors it may use. Surfaces import core only through this module; everything else
 * in core is internal. Presentation helpers shared by surfaces live in `adapters/shared`. */

// The surface contract: what composition creates a surface with, and what a surface provides.
export type { SurfaceAdapter, SurfaceAdapterContext, SurfaceDefinition, SurfaceHealth, PreparedSurface } from "./surface_adapter.js";
export type { SurfaceApplicationContext } from "./surface_application_context.js";
export type { ApprovalConversation, InteractionConversation } from "./conversation_ports.js";
export type { TurnRoutingConversation } from "./turn_routing_service.js";
export type { SurfaceListeningMode } from "./surface_state_service.js";

// Conversation routing and actions.
export { executeTurnRouting } from "./turn_routing_service.js";
export { classifySurfaceInput, type SurfaceInputClassification } from "./turn_routing_policy.js";
export { executeSurfaceAction } from "./surface_actions_service.js";
export { executeControlAction, type ControlActionRequest, type ControlActionsContext } from "./control_actions_service.js";
export { planSurfaceRecovery, readSurfaceBinding, readSurfaceStatus } from "./surface_snapshot_service.js";
export { detectImageMimeType } from "./image_media.js";

// Expected failures surfaces present.
export { ApplicationActionError, type ActionFailure } from "./action_error.js";
export { ApprovalDecisionError } from "./approvals.js";
export { ThreadBindingConflictError } from "./conversation_routing_service.js";

// Runtime lifecycle, as surfaces request and report it.
export type { RuntimeLifecycleResult, RuntimeRestartAnnouncement } from "./runtime_lifecycle_orchestrator.js";
export type { RuntimeActivity } from "./session_manager.js";
export { deploymentTargetLabel, type DeploymentStatus, type DeploymentTarget } from "./deployment_service.js";

// Signals, as the webhook receives them and surfaces present them.
export { parseSignalEnvelope, InvalidSignalError, UnknownSignalKindError, UnsupportedSignalVersionError, type RegisteredSignal, type SignalTarget } from "./signal_registry.js";
export type { SignalDispatchResult } from "./signal_dispatcher.js";
export { SignalRouteRateLimitError, type SignalRoute } from "./signal_route_registry.js";
