import type { ApprovalDecisionRequest, ApprovalRecord } from "../../shared/protocol/approvals.js";
import type { BridgeEvent } from "../../shared/protocol/events.js";
import type {
  AccountRateLimitsResponse,
  ApprovalPolicy,
  CreateThreadRequest,
  CreateThreadResponse,
  CreateSurfaceThreadRequest,
  ForkThreadRequest,
  ForkThreadResponse,
  ForkSurfaceThreadRequest,
  GetThreadStateResponse,
  ListLoadedThreadsRequest,
  ListLoadedThreadsResponse,
  ListModelsRequest,
  ListModelsResponse,
  ListStoredThreadsRequest,
  ListStoredThreadsResponse,
  ReadThreadRequest,
  ReadThreadResponse,
  ReadThreadTokenUsageResponse,
  ResumeThreadRequest,
  ResumeThreadResponse,
  ResumeSurfaceThreadRequest,
  RollbackThreadRequest,
  RollbackThreadResponse,
  SetThreadNameRequest,
  SetThreadModelRequest,
  SubmitSurfaceTurnRequest,
  SubmitSurfaceTurnResponse,
  SkillsConfigWriteRequest,
  SkillsConfigWriteResponse,
  SkillsListRequest,
  SkillsListResponse,
  SkillsRemoteExportRequest,
  SkillsRemoteExportResponse,
  SkillsRemoteListRequest,
  SkillsRemoteListResponse,
  SteerTurnRequest,
  SteerTurnResponse,
  SubmitTurnRequest,
  SubmitTurnResponse,
  SurfaceStateResponse,
  ThreadModelState,
  WorkspaceTarget,
} from "../../shared/protocol/requests.js";
import {
  ConversationRoutingService,
  type ConversationRoutingServiceOptions,
  type ResolveRouteInput,
  type ResolveRouteResult,
} from "./conversation_routing_service.js";
import { SessionManager } from "./session_manager.js";
import { WorkspaceService } from "./workspace_service.js";

type EventCursorOptions = string | { afterId?: string; replay?: boolean } | undefined;

type SurfaceSubscription = {
  listener: (event: BridgeEvent) => void;
  cursorOrOptions?: EventCursorOptions;
  unsubscribe: (() => void) | null;
  threadId: string | null;
};

function toSurfaceKey(adapter: string, surfaceId: string): string {
  return `${adapter}:${surfaceId}`;
}

export type ConversationServiceOptions = {
  routing?: ConversationRoutingServiceOptions;
};

export class ConversationService {
  private readonly manager: SessionManager;
  private readonly routing: ConversationRoutingService;
  private readonly workspaces: WorkspaceService;
  private readonly subscriptionsBySurface = new Map<string, SurfaceSubscription>();

  constructor(options: ConversationServiceOptions = {}) {
    this.manager = new SessionManager();
    this.routing = new ConversationRoutingService(this.manager, options.routing);
    this.workspaces = new WorkspaceService();
  }

  getSurfaceThread(adapter: string, surfaceId: string): string | null {
    return this.routing.getDefaultThread(adapter, surfaceId);
  }

  async bindSurfaceToThread(adapter: string, surfaceId: string, threadId: string): Promise<string> {
    const resolvedThreadId = await this.routing.setDefaultThread(adapter, surfaceId, threadId);
    this.rebindSurfaceSubscription(adapter, surfaceId, resolvedThreadId);
    return resolvedThreadId;
  }

  clearSurfaceBinding(adapter: string, surfaceId: string): void {
    this.routing.clearDefaultThread(adapter, surfaceId);
    const key = toSurfaceKey(adapter, surfaceId);
    const subscription = this.subscriptionsBySurface.get(key);
    if (!subscription) return;
    if (subscription.unsubscribe) {
      subscription.unsubscribe();
      subscription.unsubscribe = null;
    }
    subscription.threadId = null;
  }

  subscribeSurfaceEvents(
    adapter: string,
    surfaceId: string,
    listener: (event: BridgeEvent) => void,
    cursorOrOptions?: EventCursorOptions,
  ): () => void {
    const key = toSurfaceKey(adapter, surfaceId);
    const existing = this.subscriptionsBySurface.get(key);
    if (existing?.unsubscribe) {
      existing.unsubscribe();
    }

    const threadId = this.routing.getDefaultThread(adapter, surfaceId);
    const unsubscribe = threadId
      ? this.manager.subscribeToThreadEvents(threadId, listener, cursorOrOptions)
      : null;

    this.subscriptionsBySurface.set(key, {
      listener,
      cursorOrOptions,
      unsubscribe,
      threadId,
    });

    return () => {
      const current = this.subscriptionsBySurface.get(key);
      if (!current || current.listener !== listener) return;
      if (current.unsubscribe) {
        current.unsubscribe();
      }
      this.subscriptionsBySurface.delete(key);
    };
  }

  unsubscribeSurfaceEvents(adapter: string, surfaceId: string): void {
    const key = toSurfaceKey(adapter, surfaceId);
    const subscription = this.subscriptionsBySurface.get(key);
    if (!subscription) return;
    if (subscription.unsubscribe) {
      subscription.unsubscribe();
    }
    this.subscriptionsBySurface.delete(key);
  }

  async resolveSurfaceThread(input: ResolveRouteInput): Promise<ResolveRouteResult> {
    const result = await this.routing.resolveRoute(input);
    this.rebindSurfaceSubscription(input.adapter, input.surfaceId, result.threadId);
    return result;
  }

  async createSurfaceThread(
    adapter: string,
    surfaceId: string,
    request: CreateThreadRequest,
  ): Promise<CreateThreadResponse> {
    const created = await this.manager.createThread(request);
    await this.bindSurfaceToThread(adapter, surfaceId, created.threadId);
    return created;
  }

  getSurfaceState(adapter: string, surfaceId: string): SurfaceStateResponse {
    return {
      adapter,
      surfaceId,
      activeThreadId: this.routing.getDefaultThread(adapter, surfaceId),
      attachedThreadIds: this.routing.getAttachedThreads(adapter, surfaceId),
      workspaceTarget: this.workspaces.getSurfaceTarget(adapter, surfaceId),
    };
  }

  getSurfaceWorkspaceTarget(adapter: string, surfaceId: string): WorkspaceTarget | null {
    return this.workspaces.getSurfaceTarget(adapter, surfaceId);
  }

  setSurfaceWorkspaceTarget(adapter: string, surfaceId: string, target: WorkspaceTarget): WorkspaceTarget {
    this.workspaces.setSurfaceTarget(adapter, surfaceId, target);
    return target;
  }

  async createSurfaceThreadFromContext(
    adapter: string,
    surfaceId: string,
    request: CreateSurfaceThreadRequest,
  ): Promise<CreateThreadResponse> {
    const workspace = await this.workspaces.materializeSurfaceWorkspace(adapter, surfaceId);
    return this.createSurfaceThread(
      adapter,
      surfaceId,
      this.workspaces.applyCwdToCreateRequest(request, workspace.cwd),
    );
  }

  async resumeSurfaceThreadFromContext(
    adapter: string,
    surfaceId: string,
    threadId: string,
    request: ResumeSurfaceThreadRequest,
  ): Promise<ResumeThreadResponse> {
    const workspace = await this.workspaces.materializeSurfaceWorkspace(adapter, surfaceId);
    const resumed = await this.manager.resumeThread(
      threadId,
      this.workspaces.applyCwdToResumeRequest(request, workspace.cwd),
    );
    await this.bindSurfaceToThread(adapter, surfaceId, resumed.threadId);
    return resumed;
  }

  async forkSurfaceThreadFromContext(
    adapter: string,
    surfaceId: string,
    threadId: string,
    request: ForkSurfaceThreadRequest,
  ): Promise<ForkThreadResponse> {
    const workspace = await this.workspaces.materializeSurfaceWorkspace(adapter, surfaceId);
    const forked = await this.manager.forkThread(
      threadId,
      this.workspaces.applyCwdToForkRequest(request, workspace.cwd),
    );
    await this.bindSurfaceToThread(adapter, surfaceId, forked.threadId);
    return forked;
  }

  async submitSurfaceTurn(
    adapter: string,
    surfaceId: string,
    request: SubmitSurfaceTurnRequest,
  ): Promise<SubmitSurfaceTurnResponse> {
    let threadId = request.explicitThreadId ?? this.routing.getDefaultThread(adapter, surfaceId);

    if (!threadId) {
      if (request.autoCreateIfMissing === false) {
        throw new Error("No routing target available for this surface.");
      }
      const created = await this.createSurfaceThreadFromContext(adapter, surfaceId, {
        approvalPolicy: request.approvalPolicy,
        sandbox: request.sandbox,
      });
      threadId = created.threadId;
    } else if (request.explicitThreadId) {
      try {
        await this.bindSurfaceToThread(adapter, surfaceId, threadId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("not loaded")) {
          throw error;
        }
        const resumed = await this.resumeSurfaceThreadFromContext(adapter, surfaceId, threadId, {
          approvalPolicy: request.approvalPolicy,
          sandbox: request.sandbox,
        });
        threadId = resumed.threadId;
      }
    }

    const state = this.manager.getThreadState(threadId);
    if (request.autoSteerActiveTurn && state.activeTurnId) {
      const steered = await this.manager.steerTurn(threadId, {
        input: request.input,
        turnId: state.activeTurnId,
      });
      return { threadId, action: "steered", turnId: steered.turnId };
    }

    const submitted = await this.manager.submitTurn(threadId, {
      input: request.input,
      approvalPolicy: request.approvalPolicy,
      model: request.model,
    });
    return { threadId, action: "submitted", turnId: submitted.turnId };
  }

  async submitSurfaceInput(
    input: ResolveRouteInput & { text: string; approvalPolicy?: ApprovalPolicy },
  ): Promise<{ threadId: string; turn: SubmitTurnResponse; route: ResolveRouteResult }> {
    const route = await this.resolveSurfaceThread(input);
    const turn = await this.manager.submitTurn(route.threadId, {
      input: input.text,
      approvalPolicy: input.approvalPolicy,
    });
    return { threadId: route.threadId, turn, route };
  }

  createThread(request: CreateThreadRequest): Promise<CreateThreadResponse> {
    return this.manager.createThread(request);
  }

  resumeThread(threadId: string, request: ResumeThreadRequest): Promise<ResumeThreadResponse> {
    return this.manager.resumeThread(threadId, request);
  }

  forkThread(threadId: string, request: ForkThreadRequest): Promise<ForkThreadResponse> {
    return this.manager.forkThread(threadId, request);
  }

  listStoredThreads(request: ListStoredThreadsRequest): Promise<ListStoredThreadsResponse> {
    return this.manager.listStoredThreads(request);
  }

  listLoadedThreads(request: ListLoadedThreadsRequest): Promise<ListLoadedThreadsResponse> {
    return this.manager.listLoadedThreads(request);
  }

  getThreadState(threadId: string): GetThreadStateResponse {
    return this.manager.getThreadState(threadId);
  }

  readThread(threadId: string, request: ReadThreadRequest): Promise<ReadThreadResponse> {
    return this.manager.readThread(threadId, request);
  }

  setThreadName(threadId: string, request: SetThreadNameRequest): Promise<{ ok: true }> {
    return this.manager.setThreadName(threadId, request);
  }

  archiveThread(threadId: string): Promise<{ ok: true }> {
    return this.manager.archiveThread(threadId);
  }

  unarchiveThread(threadId: string): Promise<{ ok: true }> {
    return this.manager.unarchiveThread(threadId);
  }

  compactThread(threadId: string): Promise<{ ok: true }> {
    return this.manager.compactThread(threadId);
  }

  rollbackThread(threadId: string, request: RollbackThreadRequest): Promise<RollbackThreadResponse> {
    return this.manager.rollbackThread(threadId, request);
  }

  readAccountRateLimits(): Promise<AccountRateLimitsResponse> {
    return this.manager.readAccountRateLimits();
  }

  listModels(request: ListModelsRequest): Promise<ListModelsResponse> {
    return this.manager.listModels(request);
  }

  getThreadModel(threadId: string): ThreadModelState {
    return this.manager.getThreadModel(threadId);
  }

  setThreadModel(threadId: string, model: string): ThreadModelState {
    return this.manager.setThreadModel(threadId, model);
  }

  setThreadModelFromRequest(threadId: string, request: SetThreadModelRequest): ThreadModelState {
    return this.manager.setThreadModel(threadId, request.model);
  }

  listSkills(threadId: string, request: SkillsListRequest): Promise<SkillsListResponse> {
    return this.manager.listSkills(threadId, request);
  }

  listRemoteSkills(threadId: string, request: SkillsRemoteListRequest): Promise<SkillsRemoteListResponse> {
    return this.manager.listRemoteSkills(threadId, request);
  }

  exportRemoteSkill(
    threadId: string,
    request: SkillsRemoteExportRequest,
  ): Promise<SkillsRemoteExportResponse> {
    return this.manager.exportRemoteSkill(threadId, request);
  }

  writeSkillConfig(threadId: string, request: SkillsConfigWriteRequest): Promise<SkillsConfigWriteResponse> {
    return this.manager.writeSkillConfig(threadId, request);
  }

  readThreadTokenUsage(threadId: string): Promise<ReadThreadTokenUsageResponse> {
    return this.manager.readThreadTokenUsage(threadId);
  }

  getThreadCwd(threadId: string): Promise<string> {
    return this.manager.getThreadCwd(threadId);
  }

  subscribeToThreadEvents(
    threadId: string,
    listener: (event: BridgeEvent) => void,
    cursorOrOptions?: EventCursorOptions,
  ): () => void {
    return this.manager.subscribeToThreadEvents(threadId, listener, cursorOrOptions);
  }

  submitTurn(threadId: string, request: SubmitTurnRequest): Promise<SubmitTurnResponse> {
    return this.manager.submitTurn(threadId, request);
  }

  interruptTurn(threadId: string, turnId?: string): Promise<void> {
    return this.manager.interruptTurn(threadId, turnId);
  }

  steerTurn(threadId: string, request: SteerTurnRequest): Promise<SteerTurnResponse> {
    return this.manager.steerTurn(threadId, request);
  }

  listApprovals(threadId: string): ApprovalRecord[] {
    return this.manager.listApprovals(threadId);
  }

  applyApprovalDecision(threadId: string, approvalId: string, decision: ApprovalDecisionRequest): Promise<void> {
    return this.manager.applyApprovalDecision(threadId, approvalId, decision);
  }

  stopAll(): void {
    for (const subscription of this.subscriptionsBySurface.values()) {
      if (subscription.unsubscribe) {
        subscription.unsubscribe();
      }
    }
    this.subscriptionsBySurface.clear();
    this.manager.stopAll();
  }

  private rebindSurfaceSubscription(adapter: string, surfaceId: string, threadId: string): void {
    const key = toSurfaceKey(adapter, surfaceId);
    const subscription = this.subscriptionsBySurface.get(key);
    if (!subscription || subscription.threadId === threadId) {
      return;
    }

    if (subscription.unsubscribe) {
      subscription.unsubscribe();
    }

    subscription.unsubscribe = this.manager.subscribeToThreadEvents(
      threadId,
      subscription.listener,
      subscription.cursorOrOptions,
    );
    subscription.threadId = threadId;
  }
}
