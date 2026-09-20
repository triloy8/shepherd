import type { ApplicationConversation } from "./conversation_ports.js";
import type { SurfaceListeningMode } from "./surface_state_service.js";
import type { RuntimeLifecycleOrchestrator } from "./runtime_lifecycle_orchestrator.js";

/** Adapter-scoped application ports, assembled by createSurfaceRuntime. */
export type SurfaceApplicationContext = {
  conversation: ApplicationConversation;
  getSurfaceThreadId: (surfaceId: string) => string | null;
  getSurfaceProject: (surfaceId: string) => string | null;
  getSurfaceListeningMode: (surfaceId: string) => SurfaceListeningMode;
  setSurfaceListeningMode: (
    surfaceId: string,
    mode: Exclude<SurfaceListeningMode, "paused">,
  ) => SurfaceListeningMode;
  pauseSurfaceListening: (surfaceId: string) => SurfaceListeningMode;
  resumeSurfaceListening: (surfaceId: string) => SurfaceListeningMode;
  setSurfaceProject: (surfaceId: string, repoSlug: string) => Promise<{ repoSlug: string }>;
  inheritSurfaceProject?: (surfaceId: string, parentSurfaceId: string) => string | null;
  ensureSurfaceThread: (surfaceId: string) => Promise<string>;
  createSurfaceThread: (surfaceId: string) => Promise<string>;
  switchSurfaceThread: (surfaceId: string, threadId: string) => Promise<string>;
  forkSurfaceThread: (surfaceId: string, sourceThreadId: string) => Promise<string>;
  disposeSurface: (surfaceId: string) => void;
  clearSurfaceThread: (surfaceId: string) => void;
  runtimeLifecycle?: Pick<RuntimeLifecycleOrchestrator, "restart" | "deploy" | "deploymentStatus" | "runningCommit">;
};
