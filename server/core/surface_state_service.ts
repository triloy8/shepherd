import type { ProjectTarget } from "./project_target_service.js";

function toSurfaceKey(adapter: string, surfaceId: string): string {
  return `${adapter}:${surfaceId}`;
}

export class SurfaceStateService {
  private readonly projectTargetsBySurface = new Map<string, ProjectTarget>();

  getProjectTarget(adapter: string, surfaceId: string): ProjectTarget | null {
    return this.projectTargetsBySurface.get(toSurfaceKey(adapter, surfaceId)) ?? null;
  }

  setProjectTarget(adapter: string, surfaceId: string, target: ProjectTarget): ProjectTarget {
    this.projectTargetsBySurface.set(toSurfaceKey(adapter, surfaceId), target);
    return target;
  }

  clearProjectTarget(adapter: string, surfaceId: string): void {
    this.projectTargetsBySurface.delete(toSurfaceKey(adapter, surfaceId));
  }
}
