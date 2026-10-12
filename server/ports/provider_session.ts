import type * as Protocol from "../../shared/protocol/requests.js";
import type { ApprovalDecisionRequest } from "../../shared/protocol/approvals.js";
import type { UserInput } from "../../shared/protocol/user_input.js";
import type { BridgeEvent } from "../../shared/protocol/events.js";
import type { ProviderCapabilities } from "../../shared/protocol/provider_capabilities.js";

export interface ProviderEvents {
  publish(event: BridgeEvent): void;
  subscribe(listener: (event: BridgeEvent) => void, cursor?: string | { afterId?: string; replay?: boolean }): () => void;
}

export type ThreadBootstrapInfo = {
  threadId: string;
  /** Effective local workspace resolved by the adapter for create, resume and fork. */
  cwd: string;
  model: string | null;
  effort: string | null;
  approvalPolicy?: Protocol.ApprovalPolicy;
};

/** Providers are local coding agents; every bootstrapped thread has a workspace.
 * Required baseline: initialization, thread creation/resumption, turns, history and events.
 * Optional operations are declared in ProviderCapabilities and checked before execution.
 * Implementations translate native SDK traffic into BridgeEvents. */
export interface ProviderExecution {
  readonly capabilities: ProviderCapabilities;
  readonly backgroundTaskCount?: number;
  readonly sessionId: string;
  readonly eventBus: ProviderEvents;
  activeTurnId: string | null;
  approvalPolicy: Protocol.ApprovalPolicy;
  initialize(): Promise<void>;
  startThread(request: Protocol.CreateThreadRequest): Promise<ThreadBootstrapInfo>;
  resumeThread(threadId: string, request: Protocol.ResumeThreadRequest): Promise<ThreadBootstrapInfo>;
  forkThread?(threadId: string, request: Protocol.ForkThreadRequest): Promise<ThreadBootstrapInfo>;
  /** Effort: undefined preserves settings, null clears, a string selects. */
  startTurn(input: UserInput[], policy?: Protocol.ApprovalPolicy, model?: string, cwd?: string, effort?: string | null): Promise<string | null>;
  steerTurn?(input: UserInput[], turnId?: string): Promise<string | null>;
  interruptTurn?(turnId?: string): Promise<void>;
  applyApprovalDecision(id: string, decision: ApprovalDecisionRequest): Promise<{ approvalId: string }>;
  setCwd?(cwd: string): void;
  stop(): void;
}

export interface StoredThreadPage { data: Protocol.ThreadRecord[]; nextCursor: string | null; backwardsCursor?: string | null; }
export interface LoadedThreadPage { data: string[]; nextCursor: string | null; }

export interface ProviderHistory {
  listStoredThreads(request: Protocol.ListStoredThreadsRequest): Promise<StoredThreadPage>;
  /** Optional: threads the provider keeps loaded outside Shepherd's own sessions, which core already lists. */
  listLoadedThreads?(request: Protocol.ListLoadedThreadsRequest): Promise<LoadedThreadPage>;
  readThread(threadId: string, includeTurns: boolean): Promise<Protocol.ReadThreadResponse>;
  listThreadTurns(threadId: string, request: Protocol.ListThreadTurnsRequest): Promise<Protocol.ListThreadTurnsResponse>;
  /** Required application history: Discord's turn drill-down pages use individual items. */
  listThreadItems(threadId: string, request: Protocol.ListThreadItemsRequest): Promise<Protocol.ListThreadItemsResponse>;
  setThreadName?(threadId: string, name: string): Promise<void>;
  archiveThread?(threadId: string): Promise<void>;
  unarchiveThread?(threadId: string): Promise<void>;
  compactThread?(threadId: string): Promise<void>;
  revertThread?(threadId: string, beforeTurnId: string): Promise<Protocol.RevertThreadResponse>;
}

/** Discovery is scoped to the effective workspace of the requesting conversation. */
export type ProviderSkillsRequest = Protocol.SkillsListRequest & { workspacePath: string };

export interface ProviderCatalog {
  listModels?(request: Protocol.ListModelsRequest): Promise<Protocol.ListModelsResponse>;
  listSkills?(request: ProviderSkillsRequest): Promise<Protocol.SkillsListResponse>;
  writeSkillConfig?(request: Protocol.SkillsConfigWriteRequest): Promise<Protocol.SkillsConfigWriteResponse>;
}

export interface ProviderSession extends ProviderExecution, ProviderHistory, ProviderCatalog {}

export { UnsupportedProviderOperationError } from "../../shared/protocol/provider_support.js";
