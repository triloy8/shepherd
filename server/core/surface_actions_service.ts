import type { ActionFailure } from "./action_error.js";
import type { SurfaceListeningMode } from "./surface_state_service.js";

export type SurfaceActionsContext = {
  getSurfaceThreadId: (surfaceId: string) => string | null;
  getSurfaceListeningMode: (surfaceId: string) => SurfaceListeningMode;
  setSurfaceListeningMode: (surfaceId: string, mode: Exclude<SurfaceListeningMode, "paused">) => SurfaceListeningMode;
  pauseSurfaceListening: (surfaceId: string) => SurfaceListeningMode;
  resumeSurfaceListening: (surfaceId: string) => SurfaceListeningMode;
  clearSurfaceThread: (surfaceId: string) => void;
};

export type SurfaceActionRequest =
  | { type: "listening.get" | "listening.pause" | "listening.resume" | "surface.detach"; surfaceId: string }
  | { type: "listening.set"; surfaceId: string; mode: Exclude<SurfaceListeningMode, "paused"> };

export type SurfaceActionResult =
  | { ok: true; threadId: string | null; mode: SurfaceListeningMode }
  | { ok: false; error: ActionFailure };

export function executeSurfaceAction(context: SurfaceActionsContext, request: SurfaceActionRequest): SurfaceActionResult {
  const threadId = context.getSurfaceThreadId(request.surfaceId);
  if ((request.type === "surface.detach" || (request.type === "listening.set" && request.mode === "open")) && !threadId) {
    return { ok: false, error: { code: "thread_required" } };
  }
  let mode: SurfaceListeningMode;
  switch (request.type) {
    case "listening.set": mode = context.setSurfaceListeningMode(request.surfaceId, request.mode); break;
    case "listening.pause": mode = context.pauseSurfaceListening(request.surfaceId); break;
    case "listening.resume": mode = context.resumeSurfaceListening(request.surfaceId); break;
    case "surface.detach":
      context.clearSurfaceThread(request.surfaceId);
      mode = context.getSurfaceListeningMode(request.surfaceId);
      break;
    case "listening.get": mode = context.getSurfaceListeningMode(request.surfaceId); break;
  }
  return { ok: true, threadId, mode };
}
