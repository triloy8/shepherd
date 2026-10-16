import type { ProviderCapabilities } from "./provider_capabilities.js";
import type { ApprovalDecisionRequest, ApprovalRecord } from "./approvals.js";
import type { UserInput } from "./user_input.js";
import type { ModelCapabilities } from "./model_capabilities.js";
export type { EffortOption, ModelCapabilities, ModelInputModality } from "./model_capabilities.js";

import type { ExecutionPolicy } from "./execution_policy.js";
export type { ExecutionPolicy, PolicyProfile } from "./execution_policy.js";

/** The execution mode a thread runs with: one of its provider's profiles and the restrictions it
 * guarantees, or null when the agent uses its own configured defaults. */
export type ThreadPolicy = { profile: string; policy: ExecutionPolicy } | null;
export type ThreadSortKey = "created_at" | "updated_at";
export type SortDirection = "asc" | "desc";
export type AgentProvider = string;

export interface CreateThreadRequest {
  provider?: AgentProvider;
  /** Restrictions the thread must stay within; omitted uses the host policy. */
  policy?: ExecutionPolicy;
  cwd?: string;
  model?: string;
  effort?: string;
}

export interface CreateThreadResponse {
  threadId: string;
  sessionId: string;
}

/** Strings select opaque provider values; null clears, and mode default selects the model default. */
export type EffortSelection = string | null | { mode: "default" };

export interface SubmitTurnRequest {
  effort?: string | null;
  input: UserInput[];
  model?: string;
}

export interface SubmitTurnResponse {
  ok: true;
  turnId: string | null;
}

export interface InterruptTurnRequest {
  turnId?: string;
}

export interface InterruptTurnResponse {
  ok: true;
}

export interface SteerTurnRequest {
  input: UserInput[];
  turnId?: string;
}

export interface SteerTurnResponse {
  ok: true;
  turnId: string | null;
}

export interface ListThreadsResponse {
  threads: Array<{ threadId: string; sessionId: string; createdAt: string }>;
}

export interface StoredThreadSummary {
  threadId: string;
  provider: AgentProvider;
  canUnarchive: boolean;
  name: string | null;
  preview: string;
  archived: boolean;
  createdAt: number | null;
  updatedAt: number | null;
  cwd: string | null;
}

export interface ListStoredThreadsRequest {
  archived?: boolean;
  cursor?: string;
  cwd?: string | string[];
  limit?: number;
  searchTerm?: string;
  sortDirection?: SortDirection;
  sortKey?: ThreadSortKey;
}

export interface ListStoredThreadsResponse {
  /** Partial results omit these unavailable providers until the list is reloaded. */
  unavailableProviders?: AgentProvider[];
  threads: StoredThreadSummary[];
  nextCursor: string | null;
  /** Shepherd's own cursor for the previous page; core computes it across every provider. */
  backwardsCursor: string | null;
}

export interface ListLoadedThreadsRequest {
  cursor?: string;
  limit?: number;
}

export interface ListLoadedThreadsResponse {
  unavailableProviders?: AgentProvider[];
  threadIds: string[];
  nextCursor: string | null;
}

export interface GetThreadStateResponse {
  provider: AgentProvider;
  capabilities: ProviderCapabilities;
  backgroundTaskCount?: number;
  threadId: string;
  sessionId: string;
  activeTurnId: string | null;
  policy: ThreadPolicy;
}

export interface ReadThreadRequest {
  includeTurns?: boolean;
}

export interface ReadThreadResponse {
  thread: ThreadRecord;
}

export interface ResumeThreadRequest {
  provider?: AgentProvider;
  /** Restrictions the thread must stay within; omitted uses the host policy. */
  policy?: ExecutionPolicy;
  cwd?: string;
  model?: string;
  effort?: string;
}

export interface ResumeThreadResponse {
  threadId: string;
  sessionId: string;
}

export interface ForkThreadRequest {
  provider?: AgentProvider;
  /** Restrictions the thread must stay within; omitted uses the host policy. */
  policy?: ExecutionPolicy;
  cwd?: string;
  model?: string;
  effort?: string;
}

export interface ForkThreadResponse {
  threadId: string;
  sessionId: string;
}

export interface SetThreadNameRequest {
  name: string;
}

export interface ArchiveThreadResponse {
  ok: true;
}

export interface UnarchiveThreadResponse {
  ok: true;
}

export interface CompactThreadResponse {
  ok: true;
}

export interface RevertThreadRequest {
  beforeTurnId: string;
}

export interface RevertThreadResponse {
  thread: ThreadRecord;
  turnsBackwardsCursor: string | null;
  itemsBackwardsCursor: string | null;
}

export interface ThreadRecord {
  id: string;
  /** Saved model selection, when reported by the provider. */
  model?: string | null;
  name?: string | null;
  preview?: string;
  createdAt?: number;
  updatedAt?: number;
  cwd?: string;
  turns?: HistoryTurn[];
}

export interface ListApprovalsResponse {
  approvals: ApprovalRecord[];
}

export interface ApprovalDecisionApiRequest extends ApprovalDecisionRequest {}

export interface ApprovalDecisionApiResponse {
  ok: true;
}

/**
 * Token counts. Input includes cache reads and writes; output includes reasoning.
 * Null means the provider does not report that count, which is different from zero.
 */
export interface TokenUsageBreakdown {
  inputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  totalTokens: number | null;
}

/** `last` is the most recent model request, which fills the context window; `total` is cumulative. */
export interface ThreadTokenUsage {
  last: TokenUsageBreakdown | null;
  total: TokenUsageBreakdown | null;
  contextWindow: number | null;
}

export interface ReadThreadTokenUsageResponse {
  threadId: string;
  tokenUsage: ThreadTokenUsage | null;
}

export interface ListModelsRequest {
  /** Scope discovery to a loaded conversation; omitted means provider-wide discovery. */
  threadId?: string;
  provider?: AgentProvider;
  cursor?: string;
  limit?: number;
  /** Include models omitted from the normal picker; explicit IDs may still select them. */
  includeHidden?: boolean;
}

/** A selectable model. `id` is the value passed back as a thread or turn model. */
export interface ModelSummary extends ModelCapabilities {
  id: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
}

export interface ListModelsResponse {
  data: ModelSummary[];
  nextCursor: string | null;
}

export interface ThreadModelState {
  threadId: string;
  provider: AgentProvider;
  currentModel: string | null;
  pendingModel: string | null;
}

/** Where a skill was discovered, as reported by the provider (for example user, repo, or system). */
export type SkillScope = string;

export interface SkillsListRequest {
  /** Ask the provider to refresh discovery rather than use cached results. */
  refresh?: boolean;
}

/** A skill available to a conversation's workspace. */
export interface SkillMetadata {
  name: string;
  description: string;
  path: string;
  scope: SkillScope;
  enabled: boolean;
}

export interface SkillErrorInfo {
  message: string;
  path: string;
}

/** Skills a provider discovered for one workspace, and the skill files it could not load. */
export interface SkillsListing {
  skills: SkillMetadata[];
  errors: SkillErrorInfo[];
}

/** Skills available to a conversation, discovered in its effective workspace. */
export interface SkillsListResponse extends SkillsListing {
  workspacePath: string;
}

export interface SkillsConfigWriteRequest {
  enabled: boolean;
  path: string;
}

/** The skill's resulting state. Provider configuration policy can keep it from matching the request. */
export interface SkillsConfigWriteResponse {
  enabled: boolean;
}

export interface ThreadEffortState extends ModelCapabilities {
  /** False means effort options are unknown, rather than an empty supported set. */
  effortOptionsKnown?: boolean;
  threadId: string;
  model: string | null;
  currentEffort: string | null;
  pendingEffort: string | null;
  /** True means the next turn explicitly clears effort; null alone means unchanged. */
  pendingEffortClear?: boolean;
}

/** How much of each turn's item list a history page includes. `summary` is a provider-chosen
 * display summary, such as the user messages and final answer; `full` is every recorded item. */
export type HistoryItemsView = "none" | "summary" | "full";
export type TurnStatus = "completed" | "interrupted" | "failed" | "in_progress";

export interface ListThreadTurnsRequest {
  cursor?: string;
  limit?: number;
  sortDirection?: SortDirection;
  itemsView?: HistoryItemsView;
}

/** User message content as recorded in history. Media URLs are absent when withheld or unavailable.
 * Every UserInput kind has a counterpart; `attachment` covers provider content with none. */
export type HistoryContentPart =
  | { type: "text"; text: string }
  | { type: "image"; url?: string }
  | { type: "image_file"; path: string }
  | { type: "audio"; url?: string }
  | { type: "audio_file"; path: string }
  | { type: "skill"; name: string; path: string }
  | { type: "attachment"; name: string | null; path: string | null };

export interface HistoryImage {
  itemId: string;
  turnId: string | null;
  path: string;
  /** The prompt the image was generated from, when the provider reports it. */
  prompt?: string | null;
  kind: "generated" | "viewed";
}

/** Application history records. Item IDs are unique within a turn, not across the thread.
 * Adapters decode native transcripts into these before they leave the provider. */
export type HistoryItem =
  | { id: string; type: "user_message"; content: HistoryContentPart[] }
  | { id: string; type: "assistant_message"; text: string; phase?: import("./events.js").MessagePhase }
  | { id: string; type: "plan"; text: string }
  | { id: string; type: "reasoning"; summary: string[] }
  | { id: string; type: "activity"; status: import("./activity.js").ActivityStatus; activity: import("./activity.js").Activity }
  | { id: string; type: "image"; image: HistoryImage }
  | { id: string; type: "other" };

export type HistoryItemType = HistoryItem["type"];

export interface HistoryTurn {
  id: string;
  items: HistoryItem[];
  itemsView: HistoryItemsView;
  status: TurnStatus;
  error: { message: string } | null;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
}

/** Opaque provider cursors. `nextCursor` continues in the requested direction and is required
 * for every page but the last. `backwardsCursor` is optional support: when a provider offers it,
 * passing it as `cursor` with the opposite `sortDirection` pages back; null means the provider
 * cannot reverse a page, so clients page back by revisiting earlier forward cursors. */
export interface ListThreadTurnsResponse {
  data: HistoryTurn[];
  nextCursor: string | null;
  backwardsCursor: string | null;
}

export interface ListThreadItemsRequest {
  turnId?: string;
  cursor?: string;
  limit?: number;
  sortDirection?: SortDirection;
}

/** Cursor semantics match ListThreadTurnsResponse. */
export interface ListThreadItemsResponse {
  data: Array<{ turnId: string; item: HistoryItem }>;
  nextCursor: string | null;
  backwardsCursor: string | null;
}
