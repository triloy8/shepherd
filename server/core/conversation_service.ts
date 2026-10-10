import type { ProviderServices } from "./agent_provider.js";
import { AccountLimitsService } from "./account_limits_service.js";
import type { AgentProvider } from "../../shared/protocol/requests.js";
import type { ReadProviderAccountLimitsOptions } from "../../shared/protocol/provider_account_limits.js";
import type { ApprovalDecisionRequest, ApprovalRecord } from "../../shared/protocol/approvals.js";
import type { BridgeEvent } from "../../shared/protocol/events.js";
import type {
  AccountRateLimitsResponse,
  ConsumeRateLimitResetRequest,
  ConsumeRateLimitResetResponse,
  ApprovalPolicy,
  CreateThreadRequest,
  CreateThreadResponse,
  ForkThreadRequest,
  ForkThreadResponse,
  GetThreadStateResponse,
  ListLoadedThreadsRequest,
  ListLoadedThreadsResponse,
  ListModelsRequest,
  ListThreadTurnsRequest,
  ListThreadTurnsResponse,
  ListThreadItemsRequest,
  ListThreadItemsResponse,
  ListModelsResponse,
  ListStoredThreadsRequest,
  ListStoredThreadsResponse,
  ReadThreadRequest,
  ReadThreadResponse,
  ReadThreadTokenUsageResponse,
  ResumeThreadRequest,
  ResumeThreadResponse,
  RevertThreadRequest,
  RevertThreadResponse,
  SetThreadNameRequest,
  SkillsConfigWriteRequest,
  SkillsConfigWriteResponse,
  SkillsListRequest,
  SkillsListResponse,
  SteerTurnRequest,
  SteerTurnResponse,
  SubmitTurnRequest,
  SubmitTurnResponse,
  ThreadModelState,
  ThreadEffortState,
} from "../../shared/protocol/requests.js";
import type { UserInput } from "../../shared/protocol/user_input.js";
import {
  ConversationRoutingService,
  type ConversationSurface,
  type ConversationRoutingServiceOptions,
  type ResolveRouteInput,
  type ResolveRouteResult,
} from "./conversation_routing_service.js";
import {
  DynamicToolRegistry,
  type DynamicToolRegistration,
} from "./dynamic_tool_registry.js";
import { SessionManager } from "./session_manager.js";
import type { RuntimeActivity } from "./session_manager.js";

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
  providers?: ProviderServices;
};

export class ConversationService {
  private readonly dynamicTools = new DynamicToolRegistry();
  private readonly manager: SessionManager;
  private readonly routing: ConversationRoutingService;
  private readonly accountLimits: AccountLimitsService;
  private readonly subscriptionsBySurface = new Map<string, SurfaceSubscription>();

  constructor(options: ConversationServiceOptions = {}) {
    this.accountLimits = new AccountLimitsService(options.providers?.accountLimits);
    this.manager = new SessionManager(this.dynamicTools, options.providers?.createSession, options.providers?.hasStoredThreads, options.providers?.directory, options.providers?.providers);
    this.routing = new ConversationRoutingService(this.manager, options.routing);
  }

  getSurfaceThread(adapter: string, surfaceId: string): string | null {
    return this.routing.getDefaultThread(adapter, surfaceId);
  }

  getThreadSurface(threadId: string): ConversationSurface | null {
    const surface = this.routing.getSurfaceForThread(threadId);
    if (!surface) return null;
    const subscription = this.subscriptionsBySurface.get(
      toSurfaceKey(surface.adapter, surface.surfaceId),
    );
    if (!subscription?.unsubscribe || subscription.threadId !== threadId) return null;
    return surface;
  }

  registerDynamicTool(registration: DynamicToolRegistration): () => void {
    return this.dynamicTools.register(registration);
  }

  getThreadProvider(threadId: string) { return this.manager.getThreadProvider(threadId); }

  getRuntimeActivity(): RuntimeActivity {
    return this.manager.getRuntimeActivity();
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

  releaseSurface(adapter: string, surfaceId: string): void {
    this.unsubscribeSurfaceEvents(adapter, surfaceId);
    this.routing.releaseSurface(adapter, surfaceId);
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

  async submitSurfaceInput(
    input: ResolveRouteInput & { input: UserInput[]; approvalPolicy?: ApprovalPolicy },
  ): Promise<{ threadId: string; turn: SubmitTurnResponse; route: ResolveRouteResult }> {
    const route = await this.resolveSurfaceThread(input);
    const turn = await this.manager.submitTurn(route.threadId, {
      input: input.input,
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

  revertThread(threadId: string, request: RevertThreadRequest): Promise<RevertThreadResponse> {
    return this.manager.revertThread(threadId, request);
  }

  consumeRateLimitReset(request: ConsumeRateLimitResetRequest): Promise<ConsumeRateLimitResetResponse> {
    return this.manager.consumeRateLimitReset(request);
  }

  readAccountRateLimits(): Promise<AccountRateLimitsResponse> {
    return this.manager.readAccountRateLimits();
  }

  readProviderAccountLimits(provider: AgentProvider, options?: ReadProviderAccountLimitsOptions) {
    return this.accountLimits.read(provider, options);
  }

  listModels(request: ListModelsRequest): Promise<ListModelsResponse> {
    return this.manager.listModels(request);
  }

  getThreadEffort(threadId: string): Promise<ThreadEffortState> {
    return this.manager.getThreadEffort(threadId);
  }

  setThreadEffort(threadId: string, effort: string): Promise<ThreadEffortState> {
    return this.manager.setThreadEffort(threadId, effort);
  }

  listThreadTurns(threadId: string, request: ListThreadTurnsRequest): Promise<ListThreadTurnsResponse> {
    return this.manager.listThreadTurns(threadId, request);
  }

  listThreadItems(threadId: string, request: ListThreadItemsRequest): Promise<ListThreadItemsResponse> {
    return this.manager.listThreadItems(threadId, request);
  }

  getThreadModel(threadId: string): ThreadModelState {
    return this.manager.getThreadModel(threadId);
  }

  setThreadModel(threadId: string, model: string): ThreadModelState {
    return this.manager.setThreadModel(threadId, model);
  }

  listSkills(threadId: string, request: SkillsListRequest): Promise<SkillsListResponse> {
    return this.manager.listSkills(threadId, request);
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

  resolveThreadCwd(threadId: string): Promise<string> {
    return this.manager.resolveThreadCwd(threadId);
  }

  setThreadCwd(threadId: string, cwd: string): void {
    this.manager.setThreadCwd(threadId, cwd);
  }

  subscribeToThreadEvents(
    threadId: string,
    listener: (event: BridgeEvent) => void,
    cursorOrOptions?: EventCursorOptions,
  ): () => void {
    return this.manager.subscribeToThreadEvents(threadId, listener, cursorOrOptions);
  }

  readNeutralSnapshot(threadId: string) { return this.manager.readNeutralSnapshot(threadId); }
  readNeutralSnapshotItems(threadId: string, cursor: string) { return this.manager.readNeutralSnapshotItems(threadId, cursor); }
  readNeutralItems(threadId: string, cursor?: string) { return this.manager.readNeutralItems(threadId, cursor); }
  readNeutralAsset(threadId: string, id: string) { return this.manager.readNeutralAsset(threadId, id); }
  subscribeNeutralEvents(threadId: string, listener: (event: import("../../shared/protocol/v2/events.js").BridgeEvent) => void, cursor?: import("./projection_event_log.js").ProjectionCursor, onClose?: () => void) {
    return this.manager.subscribeNeutralEvents(threadId, listener, cursor, onClose);
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
    try { this.manager.stopAll(); }
    finally { this.accountLimits.stop(); }
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
