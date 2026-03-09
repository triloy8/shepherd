import type {
  WorkspaceTarget,
  CreateThreadRequest,
  ForkThreadRequest,
  ResumeThreadRequest,
} from "../../shared/protocol/requests.js";

export type MaterializedWorkspace = {
  workspaceId: string;
  cwd: string;
  target: WorkspaceTarget;
};

export interface WorkspaceProvider<T extends WorkspaceTarget = WorkspaceTarget> {
  kind: T["kind"];
  materialize(target: T): Promise<MaterializedWorkspace>;
}

function toSurfaceKey(adapter: string, surfaceId: string): string {
  return `${adapter}:${surfaceId}`;
}

export class WorkspaceService {
  private readonly targetsBySurface = new Map<string, WorkspaceTarget>();
  private readonly providers = new Map<WorkspaceTarget["kind"], WorkspaceProvider>();

  constructor(providers: WorkspaceProvider[] = []) {
    for (const provider of providers) {
      this.providers.set(provider.kind, provider);
    }
  }

  getSurfaceTarget(adapter: string, surfaceId: string): WorkspaceTarget | null {
    return this.targetsBySurface.get(toSurfaceKey(adapter, surfaceId)) ?? null;
  }

  setSurfaceTarget(adapter: string, surfaceId: string, target: WorkspaceTarget): void {
    this.targetsBySurface.set(toSurfaceKey(adapter, surfaceId), target);
  }

  clearSurfaceTarget(adapter: string, surfaceId: string): void {
    this.targetsBySurface.delete(toSurfaceKey(adapter, surfaceId));
  }

  async materializeSurfaceWorkspace(adapter: string, surfaceId: string): Promise<MaterializedWorkspace> {
    const target = this.getSurfaceTarget(adapter, surfaceId);
    if (!target) {
      throw new Error("No workspace target configured for this surface.");
    }
    return this.materializeTarget(target);
  }

  async materializeTarget(target: WorkspaceTarget): Promise<MaterializedWorkspace> {
    const provider = this.providers.get(target.kind);
    if (!provider) {
      throw new Error(`No workspace provider registered for target kind ${target.kind}.`);
    }
    return provider.materialize(target);
  }

  applyCwdToCreateRequest(request: Omit<CreateThreadRequest, "cwd">, cwd: string): CreateThreadRequest {
    return { ...request, cwd };
  }

  applyCwdToResumeRequest(request: Omit<ResumeThreadRequest, "cwd">, cwd: string): ResumeThreadRequest {
    return { ...request, cwd };
  }

  applyCwdToForkRequest(request: Omit<ForkThreadRequest, "cwd">, cwd: string): ForkThreadRequest {
    return { ...request, cwd };
  }
}
