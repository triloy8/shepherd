import type { ThreadModelState } from "../../shared/protocol/requests.js";
import type { SurfaceListeningMode } from "./surface_state_service.js";

export type SurfaceBindingReader = {
  getSurfaceThreadId: (surfaceId: string) => string | null;
  getSurfaceProject: (surfaceId: string) => string | null;
  getSurfaceListeningMode: (surfaceId: string) => SurfaceListeningMode;
};

export type SurfaceBindingSnapshot = {
  surfaceId: string;
  project: string | null;
  threadId: string | null;
  listeningMode: SurfaceListeningMode;
};

export type SurfaceStatusReader = SurfaceBindingReader & {
  conversation: {
    getThreadState: (threadId: string) => { activeTurnId: string | null };
    getThreadModel: (threadId: string) => ThreadModelState;
  };
};

export type SurfaceStatusSnapshot = SurfaceBindingSnapshot & {
  activeTurnId: string | null;
  model: ThreadModelState | null;
};

export type SurfaceRecoveryAction =
  | { type: "repo.set"; repoInput: string }
  | { type: "thread.switch"; threadId: string }
  | { type: "listening.set"; mode: "open" };

export function readSurfaceBinding(context: SurfaceBindingReader, surfaceId: string): SurfaceBindingSnapshot {
  return {
    surfaceId,
    project: context.getSurfaceProject(surfaceId),
    threadId: context.getSurfaceThreadId(surfaceId),
    listeningMode: context.getSurfaceListeningMode(surfaceId),
  };
}

export function readSurfaceStatus(context: SurfaceStatusReader, surfaceId: string): SurfaceStatusSnapshot {
  const binding = readSurfaceBinding(context, surfaceId);
  return {
    ...binding,
    activeTurnId: binding.threadId ? context.conversation.getThreadState(binding.threadId).activeTurnId : null,
    model: binding.threadId ? context.conversation.getThreadModel(binding.threadId) : null,
  };
}

/** Ordered recovery instructions, not persisted state or automatic replay. */
export function planSurfaceRecovery(binding: SurfaceBindingSnapshot): SurfaceRecoveryAction[] {
  return [
    ...(binding.project ? [{ type: "repo.set" as const, repoInput: binding.project }] : []),
    ...(binding.threadId ? [{ type: "thread.switch" as const, threadId: binding.threadId }] : []),
    ...(binding.threadId && binding.listeningMode === "open" ? [{ type: "listening.set" as const, mode: "open" as const }] : []),
  ];
}
