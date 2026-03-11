import { randomUUID } from "node:crypto";

import type { BridgeEvent } from "../../shared/protocol/events.js";
import type { ApprovalPolicy, SandboxMode } from "../../shared/protocol/requests.js";
import { ConversationService } from "./conversation_service.js";
import {
  describeProjectTarget,
  resolveProjectTarget,
  type ProjectTargetResolver,
} from "./project_target_service.js";
import { SurfaceStateService } from "./surface_state_service.js";
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

  async setSurfaceProject(surfaceId: string, rawValue: string): Promise<{ repoSlug: string }> {
    const target = await resolveProjectTarget(rawValue, this.projectTargetResolver);
    this.surfaceState.setProjectTarget(this.adapter, surfaceId, target);
    return { repoSlug: describeProjectTarget(target) };
  }

  async bindSurfaceToThread(
    surfaceId: string,
    threadId: string,
    listener: (event: BridgeEvent) => void,
  ): Promise<void> {
    await this.conversation.bindSurfaceToThread(this.adapter, surfaceId, threadId);
    this.conversation.subscribeSurfaceEvents(this.adapter, surfaceId, listener, { replay: false });
  }

  clearSurfaceThread(surfaceId: string): void {
    this.conversation.clearSurfaceBinding(this.adapter, surfaceId);
    this.conversation.unsubscribeSurfaceEvents(this.adapter, surfaceId);
  }

  async createAndBindSurfaceThread(
    surfaceId: string,
    listener: (event: BridgeEvent) => void,
  ): Promise<string> {
    const workspace = await this.createWorkspaceForSurface(surfaceId);
    const created = await this.conversation.createSurfaceThread(this.adapter, surfaceId, {
      approvalPolicy: this.approvalPolicy,
      cwd: workspace.cwd,
      ...(this.sandbox ? { sandbox: this.sandbox } : {}),
    });
    this.conversation.subscribeSurfaceEvents(this.adapter, surfaceId, listener, { replay: false });
    return created.threadId;
  }

  async resumeSurfaceThread(
    surfaceId: string,
    threadId: string,
    listener: (event: BridgeEvent) => void,
  ): Promise<string> {
    const workspace = await this.createWorkspaceForSurface(surfaceId);
    const resumed = await this.conversation.resumeThread(threadId, {
      cwd: workspace.cwd,
      ...(this.sandbox ? { sandbox: this.sandbox } : {}),
    });
    await this.bindSurfaceToThread(surfaceId, resumed.threadId, listener);
    return resumed.threadId;
  }

  async forkSurfaceThread(
    surfaceId: string,
    sourceThreadId: string,
    listener: (event: BridgeEvent) => void,
  ): Promise<string> {
    const workspace = await this.createWorkspaceForSurface(surfaceId);
    const forked = await this.conversation.forkThread(sourceThreadId, {
      cwd: workspace.cwd,
      ...(this.sandbox ? { sandbox: this.sandbox } : {}),
    });
    await this.bindSurfaceToThread(surfaceId, forked.threadId, listener);
    return forked.threadId;
  }

  async switchSurfaceThread(
    surfaceId: string,
    requestedThreadId: string,
    listener: (event: BridgeEvent) => void,
  ): Promise<string> {
    let resolvedThreadId = requestedThreadId;
    try {
      this.conversation.getThreadState(requestedThreadId);
      await this.bindSurfaceToThread(surfaceId, requestedThreadId, listener);
    } catch {
      resolvedThreadId = await this.resumeSurfaceThread(surfaceId, requestedThreadId, listener);
    }
    return resolvedThreadId;
  }

  async ensureSurfaceThread(
    surfaceId: string,
    listener: (event: BridgeEvent) => void,
  ): Promise<string> {
    const current = this.getSurfaceThread(surfaceId);
    if (current) return current;
    return this.createAndBindSurfaceThread(surfaceId, listener);
  }

  private async createWorkspaceForSurface(
    surfaceId: string,
  ): Promise<{ workspaceId: string; cwd: string }> {
    const target = this.surfaceState.getProjectTarget(this.adapter, surfaceId);
    if (!target) {
      throw new Error("No repo selected for this channel. Use `!repo <owner>/<repo>`, `!repo ~`, or `!repo ~/path` first.");
    }
    return this.workspaceProvisioner.provisionWorkspace(target, randomUUID());
  }
}
