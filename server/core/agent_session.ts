import type * as Protocol from "../../shared/protocol/requests.js";
import type { ApprovalDecisionRequest } from "../../shared/protocol/approvals.js";
import type { UserInput } from "../../shared/protocol/user_input.js";
import type { EventBus } from "./event_bus.js";

export type ThreadBootstrapInfo = {
  threadId: string;
  model: string | null;
  modelProvider: string | null;
  reasoningEffort: string | null;
  approvalPolicy?: Protocol.ApprovalPolicy;
};

/** Provider boundary. Implementations translate native SDK traffic into BridgeEvents. */
export interface AgentSession {
  readonly sessionId: string;
  readonly eventBus: EventBus;
  activeTurnId: string | null;
  approvalPolicy: Protocol.ApprovalPolicy;
  initialize(): Promise<void>;
  startThread(request: Protocol.CreateThreadRequest): Promise<ThreadBootstrapInfo>;
  resumeThread(threadId: string, request: Protocol.ResumeThreadRequest): Promise<ThreadBootstrapInfo>;
  forkThread(threadId: string, request: Protocol.ForkThreadRequest): Promise<ThreadBootstrapInfo>;
  startTurn(input: UserInput[], policy?: Protocol.ApprovalPolicy, model?: string, cwd?: string, effort?: string): Promise<string | null>;
  steerTurn(input: UserInput[], turnId?: string): Promise<string | null>;
  interruptTurn(turnId?: string): Promise<void>;
  applyApprovalDecision(id: string, decision: ApprovalDecisionRequest): Promise<{ method: string; approvalId: string }>;
  listStoredThreads(request: Protocol.ListStoredThreadsRequest): Promise<unknown>;
  listLoadedThreads(request: Protocol.ListLoadedThreadsRequest): Promise<unknown>;
  readThread(threadId: string, includeTurns: boolean): Promise<unknown>;
  listThreadTurns(threadId: string, request: Protocol.ListThreadTurnsRequest): Promise<Protocol.ListThreadTurnsResponse>;
  listThreadItems(threadId: string, request: Protocol.ListThreadItemsRequest): Promise<Protocol.ListThreadItemsResponse>;
  setThreadName(threadId: string, name: string): Promise<void>;
  archiveThread(threadId: string): Promise<void>;
  unarchiveThread(threadId: string): Promise<void>;
  compactThread(threadId: string): Promise<void>;
  revertThread(threadId: string, beforeTurnId: string): Promise<unknown>;
  listModels(request: Protocol.ListModelsRequest): Promise<Protocol.ListModelsResponse>;
  listSkills(request: Protocol.SkillsListRequest): Promise<Protocol.SkillsListResponse>;
  writeSkillConfig(request: Protocol.SkillsConfigWriteRequest): Promise<Protocol.SkillsConfigWriteResponse>;
  readAccountRateLimits(): Promise<unknown>;
  consumeRateLimitReset(request: Protocol.ConsumeRateLimitResetRequest): Promise<unknown>;
  setCwd?(cwd: string): void;
  stop(): void;
}

export class UnsupportedProviderOperationError extends Error {
  constructor(provider: string, operation: string) { super(`${provider} provider does not support ${operation}.`); }
}
