import type { ProjectTarget } from "./project_target_service.js";

export type SurfaceListeningMode = "mention" | "open" | "paused";

type SurfaceListeningState = {
  mode: SurfaceListeningMode;
  resumeMode: Exclude<SurfaceListeningMode, "paused">;
};

function toSurfaceKey(adapter: string, surfaceId: string): string {
  return `${adapter}:${surfaceId}`;
}

export class SurfaceStateService {
  private readonly projectTargetsBySurface = new Map<string, ProjectTarget>();
  private readonly listeningStateBySurface = new Map<string, SurfaceListeningState>();

  getProjectTarget(adapter: string, surfaceId: string): ProjectTarget | null {
    return this.projectTargetsBySurface.get(toSurfaceKey(adapter, surfaceId)) ?? null;
  }

  setProjectTarget(adapter: string, surfaceId: string, target: ProjectTarget): ProjectTarget {
    this.projectTargetsBySurface.set(toSurfaceKey(adapter, surfaceId), target);
    return target;
  }

  inheritProjectTarget(adapter: string, surfaceId: string, parentSurfaceId: string): ProjectTarget | null {
    const existing = this.getProjectTarget(adapter, surfaceId);
    if (existing) return existing;

    const parentTarget = this.getProjectTarget(adapter, parentSurfaceId);
    if (!parentTarget) return null;
    this.projectTargetsBySurface.set(toSurfaceKey(adapter, surfaceId), parentTarget);
    return parentTarget;
  }

  clearProjectTarget(adapter: string, surfaceId: string): void {
    this.projectTargetsBySurface.delete(toSurfaceKey(adapter, surfaceId));
  }

  getListeningMode(adapter: string, surfaceId: string): SurfaceListeningMode {
    return this.listeningStateBySurface.get(toSurfaceKey(adapter, surfaceId))?.mode ?? "mention";
  }

  setListeningMode(
    adapter: string,
    surfaceId: string,
    mode: Exclude<SurfaceListeningMode, "paused">,
  ): SurfaceListeningMode {
    this.listeningStateBySurface.set(toSurfaceKey(adapter, surfaceId), {
      mode,
      resumeMode: mode,
    });
    return mode;
  }

  pauseListening(adapter: string, surfaceId: string): SurfaceListeningMode {
    const key = toSurfaceKey(adapter, surfaceId);
    const current = this.listeningStateBySurface.get(key);
    this.listeningStateBySurface.set(key, {
      mode: "paused",
      resumeMode: current?.mode === "open" ? "open" : current?.resumeMode ?? "mention",
    });
    return "paused";
  }

  resumeListening(adapter: string, surfaceId: string): SurfaceListeningMode {
    const key = toSurfaceKey(adapter, surfaceId);
    const current = this.listeningStateBySurface.get(key);
    const mode = current?.mode === "paused" ? current.resumeMode : current?.mode ?? "mention";
    this.listeningStateBySurface.set(key, { mode, resumeMode: mode });
    return mode;
  }

  resetListeningMode(adapter: string, surfaceId: string): void {
    this.listeningStateBySurface.delete(toSurfaceKey(adapter, surfaceId));
  }
}
