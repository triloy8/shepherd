import type {
  ApprovalPolicy,
  ResumeThreadRequest,
  SandboxMode,
} from "../../shared/protocol/requests.js";
import type { SessionManager } from "./session_manager.js";

type SurfaceKey = string;

type SurfaceState = {
  adapter: string;
  surfaceId: string;
  defaultThreadId: string | null;
  attachedThreadIds: Set<string>;
  autoCreateIfMissing: boolean;
  defaultApprovalPolicy: ApprovalPolicy;
  defaultSandbox?: SandboxMode;
  exclusiveThreadBinding: boolean;
};

export type ResolveRouteInput = {
  adapter: string;
  surfaceId: string;
  cwd: string;
  explicitThreadId?: string;
  autoCreateIfMissing?: boolean;
  approvalPolicyHint?: ApprovalPolicy;
  sandboxHint?: SandboxMode;
};

export type ResolveRouteResult = {
  threadId: string;
  created: boolean;
  resumed: boolean;
  reason: "explicit" | "default" | "auto-created";
};

export type ConversationRoutingServiceOptions = {
  autoCreateIfMissing?: boolean;
  defaultApprovalPolicy?: ApprovalPolicy;
  defaultSandbox?: SandboxMode;
  exclusiveThreadBinding?: boolean;
};

export class ConversationRoutingService {
  private readonly surfaces = new Map<SurfaceKey, SurfaceState>();
  private readonly surfaceByThread = new Map<string, SurfaceKey>();
  private readonly autoCreateIfMissing: boolean;
  private readonly defaultApprovalPolicy: ApprovalPolicy;
  private readonly defaultSandbox?: SandboxMode;
  private readonly exclusiveThreadBinding: boolean;

  constructor(
    private readonly manager: SessionManager,
    options: ConversationRoutingServiceOptions = {},
  ) {
    this.autoCreateIfMissing = options.autoCreateIfMissing ?? true;
    this.defaultApprovalPolicy = options.defaultApprovalPolicy ?? "on-request";
    this.defaultSandbox = options.defaultSandbox;
    this.exclusiveThreadBinding = options.exclusiveThreadBinding ?? false;
  }

  getDefaultThread(adapter: string, surfaceId: string): string | null {
    return this.getSurface(adapter, surfaceId)?.defaultThreadId ?? null;
  }

  getAttachedThreads(adapter: string, surfaceId: string): string[] {
    const surface = this.getSurface(adapter, surfaceId);
    if (!surface) return [];
    return [...surface.attachedThreadIds];
  }

  async setDefaultThread(
    adapter: string,
    surfaceId: string,
    threadId: string,
    request?: ResumeThreadRequest,
  ): Promise<string> {
    const surface = this.ensureSurface(adapter, surfaceId);
    const canonicalThreadId = await this.ensureThreadAvailable(threadId, request);
    this.enforceExclusiveBinding(surface, canonicalThreadId);

    const previousDefault = surface.defaultThreadId;
    if (previousDefault && previousDefault !== canonicalThreadId) {
      this.surfaceByThread.delete(previousDefault);
    }

    surface.attachedThreadIds.add(canonicalThreadId);
    surface.defaultThreadId = canonicalThreadId;
    this.surfaceByThread.set(canonicalThreadId, this.toSurfaceKey(adapter, surfaceId));
    return canonicalThreadId;
  }

  clearDefaultThread(adapter: string, surfaceId: string): void {
    const surface = this.getSurface(adapter, surfaceId);
    if (!surface) return;
    if (surface.defaultThreadId) {
      this.surfaceByThread.delete(surface.defaultThreadId);
    }
    surface.defaultThreadId = null;
  }

  async resolveRoute(input: ResolveRouteInput): Promise<ResolveRouteResult> {
    const surface = this.ensureSurface(input.adapter, input.surfaceId);
    const candidate = input.explicitThreadId ?? surface.defaultThreadId;

    if (candidate) {
      const resumeRequest = {
        approvalPolicy: input.approvalPolicyHint ?? surface.defaultApprovalPolicy,
        ...(input.sandboxHint ? { sandbox: input.sandboxHint } : {}),
        cwd: input.cwd,
      };
      const resolved = await this.setDefaultThread(input.adapter, input.surfaceId, candidate, resumeRequest);
      return {
        threadId: resolved,
        created: false,
        resumed: resolved !== candidate,
        reason: input.explicitThreadId ? "explicit" : "default",
      };
    }

    const allowAutoCreate = input.autoCreateIfMissing ?? surface.autoCreateIfMissing;
    if (!allowAutoCreate) {
      throw new Error("No routing target available for this surface.");
    }
    const created = await this.manager.createThread({
      approvalPolicy: input.approvalPolicyHint ?? surface.defaultApprovalPolicy,
      sandbox: input.sandboxHint ?? surface.defaultSandbox,
      cwd: input.cwd,
    });
    await this.setDefaultThread(input.adapter, input.surfaceId, created.threadId);
    return {
      threadId: created.threadId,
      created: true,
      resumed: false,
      reason: "auto-created",
    };
  }

  private ensureSurface(adapter: string, surfaceId: string): SurfaceState {
    const key = this.toSurfaceKey(adapter, surfaceId);
    const existing = this.surfaces.get(key);
    if (existing) return existing;

    const created: SurfaceState = {
      adapter,
      surfaceId,
      defaultThreadId: null,
      attachedThreadIds: new Set<string>(),
      autoCreateIfMissing: this.autoCreateIfMissing,
      defaultApprovalPolicy: this.defaultApprovalPolicy,
      defaultSandbox: this.defaultSandbox,
      exclusiveThreadBinding: this.exclusiveThreadBinding,
    };
    this.surfaces.set(key, created);
    return created;
  }

  private getSurface(adapter: string, surfaceId: string): SurfaceState | null {
    return this.surfaces.get(this.toSurfaceKey(adapter, surfaceId)) ?? null;
  }

  private toSurfaceKey(adapter: string, surfaceId: string): SurfaceKey {
    return `${adapter}:${surfaceId}`;
  }

  private enforceExclusiveBinding(surface: SurfaceState, threadId: string): void {
    if (!surface.exclusiveThreadBinding) return;

    const current = this.surfaceByThread.get(threadId);
    const target = this.toSurfaceKey(surface.adapter, surface.surfaceId);
    if (current && current !== target) {
      throw new Error(`Thread ${threadId} is already active on another surface.`);
    }
  }

  private async ensureThreadAvailable(threadId: string, request?: ResumeThreadRequest): Promise<string> {
    try {
      this.manager.getThreadState(threadId);
      return threadId;
    } catch {
      const resumed = await this.manager.resumeThread(threadId, request ?? {});
      return resumed.threadId;
    }
  }
}
