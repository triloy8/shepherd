import type * as Protocol from "../../shared/protocol/requests.js";
import type { ApprovalDecisionRequest } from "../../shared/protocol/approvals.js";
import type { UserInput } from "../../shared/protocol/user_input.js";
import type { BridgeEvent } from "../../shared/protocol/events.js";
import type { ProviderCapabilities } from "../../shared/protocol/provider_capabilities.js";

export interface ProviderEvents {
  publish(event: BridgeEvent): void;
  subscribe(listener: (event: BridgeEvent) => void, cursor?: string | { afterId?: string; replay?: boolean }): () => void;
}

/** The settings a thread runs with, as bootstrap reports them and `thread.settings.changed` updates them. */
export type ThreadBootstrapInfo = {
  /** Provider-local identity by default; composition translates it to a stable application ID. */
  threadId: string;
  /** Effective local workspace resolved by the adapter for create, resume and fork. */
  cwd: string;
  model: string | null;
  effort: string | null;
  /** The policy profile the thread runs with, or null for the agent's own defaults. */
  profile: string | null;
};

/** Create, resume and fork as the adapter receives them: core has resolved the host or requested
 * policy to one of the provider's profiles, or null to leave the agent's own defaults. */
export type ProviderThreadRequest = Pick<Protocol.CreateThreadRequest, "cwd" | "model" | "effort"> & { profile?: string | null };

/** Settings for one turn. Omitted fields keep the thread's current value; `effort: null` clears
 * the effort override. The workspace is not a turn setting: it changes through `setCwd`. */
export interface TurnSettings {
  model?: string;
  effort?: string | null;
}

/** Providers are local coding agents; every bootstrapped thread has a workspace.
 * Required baseline: initialization, thread creation/resumption, turns, history and events.
 * Optional operations are declared in ProviderCapabilities and checked before execution.
 * Implementations translate native SDK traffic into BridgeEvents. Core learns a thread's state
 * from those events (`turn.*`, `thread.status.changed`, `thread.settings.changed`), never by
 * reading adapter fields. */
export interface ProviderExecution {
  readonly capabilities: ProviderCapabilities;
  readonly sessionId: string;
  readonly eventBus: ProviderEvents;
  /** Core awaits initialization before discovery, history or bootstrap. Must be safe to call again. */
  initialize(): Promise<void>;
  startThread(request: ProviderThreadRequest): Promise<ThreadBootstrapInfo>;
  resumeThread(threadId: string, request: ProviderThreadRequest): Promise<ThreadBootstrapInfo>;
  forkThread?(threadId: string, request: ProviderThreadRequest): Promise<ThreadBootstrapInfo>;
  /** Publishes `turn.started` before returning, and `thread.settings.changed` when the turn
   * changes the settings the thread runs with. */
  startTurn(input: UserInput[], settings: TurnSettings): Promise<string | null>;
  steerTurn?(input: UserInput[], turnId?: string): Promise<string | null>;
  interruptTurn?(turnId?: string): Promise<void>;
  applyApprovalDecision(id: string, decision: ApprovalDecisionRequest): Promise<{ approvalId: string }>;
  /** Publishes `thread.settings.changed`; later turns run in the new workspace. */
  setCwd?(cwd: string): void;
  stop(): void;
}

export interface StoredThreadPage { data: Protocol.ThreadRecord[]; nextCursor: string | null; backwardsCursor?: string | null; }
export interface LoadedThreadPage { data: string[]; nextCursor: string | null; }

/** A provider's conversation history. Providers answer for every thread, including threads one
 * of their sessions is running; how they reach a running thread is theirs to decide. */
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
}

/** Discovery is scoped to the effective workspace of the requesting conversation. */
export type ProviderSkillsRequest = Protocol.SkillsListRequest & { workspacePath: string };

/** One installed agent: provider-wide history and model discovery, and a session per running
 * thread. Core never creates a session to read history or list models. */
export interface Provider extends ProviderHistory {
  readonly capabilities: ProviderCapabilities;
  openSession(tools: import("./provider_tools.js").ProviderTools): ThreadSession;
  /** Provider-wide model discovery (`modelCatalogScope: "provider"`). */
  listModels?(request: Protocol.ListModelsRequest): Promise<Protocol.ListModelsResponse>;
  stop?(): void;
}

/** One running thread: execution, events, approvals, and operations on that conversation. */
export interface ThreadSession extends ProviderExecution {
  compactThread?(threadId: string): Promise<void>;
  revertThread?(threadId: string, beforeTurnId: string): Promise<Protocol.RevertThreadResponse>;
  /** The conversation's model catalog (`modelCatalogScope: "conversation"`). */
  listModels?(request: Protocol.ListModelsRequest): Promise<Protocol.ListModelsResponse>;
  listSkills?(request: ProviderSkillsRequest): Promise<Protocol.SkillsListing>;
  writeSkillConfig?(request: Protocol.SkillsConfigWriteRequest): Promise<Protocol.SkillsConfigWriteResponse>;
}

export { UnsupportedProviderOperationError } from "../../shared/protocol/provider_support.js";
