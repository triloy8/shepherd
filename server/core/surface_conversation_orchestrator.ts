import { ApplicationActionError } from "./action_error.js";
import type { BridgeEvent } from "../../shared/protocol/events.js";
import type { ApprovalPolicy, SandboxMode } from "../../shared/protocol/requests.js";
import { ConversationService } from "./conversation_service.js";
import {
  describeProjectTarget,
  resolveProjectTarget,
  type ProjectTargetResolver,
} from "./project_target_service.js";
import {
  SurfaceStateService,
  type SurfaceListeningMode,
} from "./surface_state_service.js";
import { WorkspaceProvisioner } from "./workspace_provisioner.js";

export type SurfaceConversationOrchestratorOptions = {
  adapter: string;
  approvalPolicy: ApprovalPolicy;
  sandbox?: SandboxMode;
  projectTargetResolver?: ProjectTargetResolver;
};

export class SurfaceConversationOrchestrator {
  private readonly adapter: string;
  private readonly approvalPolicy: ApprovalPolicy;
  private readonly sandbox?: SandboxMode;
  private readonly projectTargetResolver?: ProjectTargetResolver;

  constructor(
    private readonly conversation: ConversationService,
    private readonly surfaceState: SurfaceStateService,
    private readonly workspaceProvisioner: WorkspaceProvisioner,
    options: SurfaceConversationOrchestratorOptions,
  ) {
    this.adapter = options.adapter;
    this.approvalPolicy = options.approvalPolicy;
    this.sandbox = options.sandbox;
    this.projectTargetResolver = options.projectTargetResolver;
  }

  getSurfaceThread(surfaceId: string): string | null {
    return this.conversation.getSurfaceThread(this.adapter, surfaceId);
  }

  getSurfaceProjectDisplay(surfaceId: string): string | null {
    const target = this.surfaceState.getProjectTarget(this.adapter, surfaceId);
    return target ? describeProjectTarget(target) : null;
  }

  getSurfaceListeningMode(surfaceId: string): SurfaceListeningMode {
    return this.surfaceState.getListeningMode(this.adapter, surfaceId);
  }

  setSurfaceListeningMode(
    surfaceId: string,
    mode: Exclude<SurfaceListeningMode, "paused">,
  ): SurfaceListeningMode {
    if (mode === "open" && !this.getSurfaceThread(surfaceId)) {
      throw new ApplicationActionError({ code: "thread_required" });
    }
    return this.surfaceState.setListeningMode(this.adapter, surfaceId, mode);
  }

  pauseSurfaceListening(surfaceId: string): SurfaceListeningMode {
    return this.surfaceState.pauseListening(this.adapter, surfaceId);
  }

  resumeSurfaceListening(surfaceId: string): SurfaceListeningMode {
    const mode = this.surfaceState.getResumeListeningMode(this.adapter, surfaceId);
    return this.setSurfaceListeningMode(surfaceId, mode);
  }

  async setSurfaceProject(surfaceId: string, rawValue: string): Promise<{ repoSlug: string }> {
    const target = await resolveProjectTarget(rawValue, this.projectTargetResolver);
    this.surfaceState.setProjectTarget(this.adapter, surfaceId, target);
    return { repoSlug: describeProjectTarget(target) };
  }

  inheritSurfaceProject(surfaceId: string, parentSurfaceId: string): string | null {
    const target = this.surfaceState.inheritProjectTarget(this.adapter, surfaceId, parentSurfaceId);
    return target ? describeProjectTarget(target) : null;
  }

  async bindSurfaceToThread(
    surfaceId: string,
    threadId: string,
    listener: (event: BridgeEvent) => void,
  ): Promise<void> {
    const needsProject = !this.surfaceState.getProjectTarget(this.adapter, surfaceId);
    const cwd = needsProject ? await this.conversation.resolveThreadCwd(threadId) : null;
    await this.conversation.bindSurfaceToThread(this.adapter, surfaceId, threadId);
    // Restore a default project binding for surfaces opened without a project.
    // An explicitly configured Discord binding remains the target for future work.
    if (cwd) {
      this.surfaceState.setProjectTarget(this.adapter, surfaceId, {
        kind: "local", rootPath: cwd, display: cwd, appendWorkspaceId: false,
      });
    }
    this.conversation.subscribeSurfaceEvents(this.adapter, surfaceId, listener, { replay: false });
  }

  clearSurfaceThread(surfaceId: string): void {
    this.conversation.clearSurfaceBinding(this.adapter, surfaceId);
    this.conversation.unsubscribeSurfaceEvents(this.adapter, surfaceId);
    this.surfaceState.resetListeningMode(this.adapter, surfaceId);
  }

  disposeSurface(surfaceId: string): void {
    this.conversation.releaseSurface(this.adapter, surfaceId);
    this.surfaceState.clearProjectTarget(this.adapter, surfaceId);
    this.surfaceState.resetListeningMode(this.adapter, surfaceId);
  }

  async createAndBindSurfaceThread(
    surfaceId: string,
    listener: (event: BridgeEvent) => void,
  ): Promise<string> {
    this.getSurfaceProjectTarget(surfaceId);
    const created = await this.conversation.createSurfaceThread(this.adapter, surfaceId, {
      approvalPolicy: this.approvalPolicy,
      ...(this.sandbox ? { sandbox: this.sandbox } : {}),
    });
    try {
      await this.provisionAndBindThreadWorkspace(surfaceId, created.threadId);
      this.conversation.subscribeSurfaceEvents(this.adapter, surfaceId, listener, { replay: false });
      return created.threadId;
    } catch (error) {
      this.clearSurfaceThread(surfaceId);
      throw error;
    }
  }

  async resumeSurfaceThread(
    surfaceId: string,
    threadId: string,
    listener: (event: BridgeEvent) => void,
  ): Promise<string> {
    const cwd = await this.conversation.resolveThreadCwd(threadId);
    await this.workspaceProvisioner.requireExistingWorkspace(cwd);
    const resumed = await this.conversation.resumeThread(threadId, {
      cwd,
      ...(this.sandbox ? { sandbox: this.sandbox } : {}),
    });
    this.conversation.setThreadCwd(resumed.threadId, cwd);
    await this.bindSurfaceToThread(surfaceId, resumed.threadId, listener);
    return resumed.threadId;
  }

  async forkSurfaceThread(
    surfaceId: string,
    sourceThreadId: string,
    listener: (event: BridgeEvent) => void,
  ): Promise<string> {
    this.getSurfaceProjectTarget(surfaceId);
    const forked = await this.conversation.forkThread(sourceThreadId, {
      ...(this.sandbox ? { sandbox: this.sandbox } : {}),
    });
    await this.provisionAndBindThreadWorkspace(surfaceId, forked.threadId);
    await this.bindSurfaceToThread(surfaceId, forked.threadId, listener);
    return forked.threadId;
  }

  async switchSurfaceThread(
    surfaceId: string,
    requestedThreadId: string,
    listener: (event: BridgeEvent) => void,
  ): Promise<string> {
    try {
      this.conversation.getThreadState(requestedThreadId);
    } catch {
      return this.resumeSurfaceThread(surfaceId, requestedThreadId, listener);
    }
    // A binding conflict is not a missing thread: never resume or change its cwd.
    await this.bindSurfaceToThread(surfaceId, requestedThreadId, listener);
    return requestedThreadId;
  }

  async ensureSurfaceThread(
    surfaceId: string,
    listener: (event: BridgeEvent) => void,
  ): Promise<string> {
    const current = this.getSurfaceThread(surfaceId);
    if (current) return current;
    return this.createAndBindSurfaceThread(surfaceId, listener);
  }

  private async createWorkspaceForThread(
    surfaceId: string,
    threadId: string,
  ): Promise<{ workspaceId: string; cwd: string }> {
    const target = this.getSurfaceProjectTarget(surfaceId);
    return this.workspaceProvisioner.provisionWorkspace(target, threadId);
  }

  private async provisionAndBindThreadWorkspace(surfaceId: string, threadId: string): Promise<void> {
    const workspace = await this.createWorkspaceForThread(surfaceId, threadId);
    this.conversation.setThreadCwd(threadId, workspace.cwd);
  }

  private getSurfaceProjectTarget(surfaceId: string) {
    const target = this.surfaceState.getProjectTarget(this.adapter, surfaceId);
    if (!target) {
      throw new ApplicationActionError({ code: "project_required" });
    }
    return target;
  }
}
