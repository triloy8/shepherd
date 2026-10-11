import type { ProviderCapabilities } from "./provider_capabilities.js";
import type { ApprovalDecisionRequest, ApprovalRecord } from "./approvals.js";
import type { UserInput } from "./user_input.js";

/** Review thresholds refer to the provider's trust/permission model. No mode promises universal review. */
export type ApprovalPolicy = "provider_default" | "review_sensitive" | "review_untrusted" | "bypass";
export type SandboxMode = "read_only" | "workspace_write" | "unrestricted";
export type ThreadSortKey = "created_at" | "updated_at";
export type SortDirection = "asc" | "desc";
export type AgentProvider = string;

export interface CreateThreadRequest {
  provider?: AgentProvider;
  approvalPolicy?: ApprovalPolicy;
  /** Added to the provider's default instructions; never replaces them. */
  instructions?: string;
  cwd?: string;
  sandbox?: SandboxMode;
  model?: string;
  ephemeral?: boolean;
  effort?: string;
}

export interface CreateThreadResponse {
  threadId: string;
  sessionId: string;
}

export interface SubmitTurnRequest {
  effort?: string;
  input: UserInput[];
  approvalPolicy?: ApprovalPolicy;
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
  threads: StoredThreadSummary[];
  nextCursor: string | null;
  backwardsCursor: string | null;
}

export interface ListLoadedThreadsRequest {
  cursor?: string;
  limit?: number;
}

export interface ListLoadedThreadsResponse {
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
  approvalPolicy: ApprovalPolicy;
}

export interface ReadThreadRequest {
  includeTurns?: boolean;
}

export interface ReadThreadResponse {
  thread: ThreadRecord;
}

export interface ResumeThreadRequest {
  provider?: AgentProvider;
  approvalPolicy?: ApprovalPolicy;
  /** Added to the provider's default instructions; never replaces them. */
  instructions?: string;
  cwd?: string;
  sandbox?: SandboxMode;
  model?: string;
  effort?: string;
}

export interface ResumeThreadResponse {
  threadId: string;
  sessionId: string;
}

export interface ForkThreadRequest {
  provider?: AgentProvider;
  approvalPolicy?: ApprovalPolicy;
  /** Added to the provider's default instructions; never replaces them. */
  instructions?: string;
  cwd?: string;
  sandbox?: SandboxMode;
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
  inputTokens: number;
  cacheReadInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number;
  reasoningOutputTokens: number | null;
  totalTokens: number;
}

/** `last` is the most recent model request, which fills the context window; `total` is cumulative. */
export interface ThreadTokenUsage {
  last: TokenUsageBreakdown;
  total: TokenUsageBreakdown;
  contextWindow: number | null;
}

export interface ReadThreadTokenUsageResponse {
  threadId: string;
  tokenUsage: ThreadTokenUsage | null;
}

export interface ListModelsRequest {
  provider?: AgentProvider;
  cursor?: string;
  limit?: number;
  includeHidden?: boolean;
}

/** An effort level offered by a model. Values are opaque provider-defined strings. */
export interface EffortOption {
  value: string;
  description: string;
}

/** A selectable model. `id` is the value passed back as a thread or turn model. */
export interface ModelSummary {
  id: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
  supportedEfforts: EffortOption[];
  defaultEffort: string | null;
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
  cwds?: string[];
  forceReload?: boolean;
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

export interface SkillsListEntry {
  cwd: string;
  errors: SkillErrorInfo[];
  skills: SkillMetadata[];
}

export interface SkillsListResponse {
  data: SkillsListEntry[];
}

export interface SkillsConfigWriteRequest {
  enabled: boolean;
  path: string;
}

export interface SkillsConfigWriteResponse {
  effectiveEnabled: boolean;
}

export interface ThreadEffortState {
  threadId: string;
  model: string;
  currentEffort: string | null;
  pendingEffort: string | null;
  defaultEffort: string | null;
  supportedEfforts: EffortOption[];
}

/** How much of each turn's item list a history page includes. */
export type HistoryItemsView = "none" | "summary" | "full";
export type TurnStatus = "completed" | "interrupted" | "failed" | "in_progress";

export interface ListThreadTurnsRequest {
  cursor?: string;
  limit?: number;
  sortDirection?: SortDirection;
  itemsView?: HistoryItemsView;
}

/** User message content as recorded in history. Image URLs are absent when withheld or unavailable. */
export type HistoryContentPart =
  | { type: "text"; text: string }
  | { type: "image"; url?: string }
  | { type: "image_file"; path: string }
  | { type: "attachment"; name: string | null; path: string | null };

export interface HistoryImage {
  itemId: string;
  turnId: string | null;
  path: string;
  revisedPrompt?: string | null;
  kind: "generated" | "viewed";
}

type HistoryActivity = import("./events.js").TurnActivityEvent["payload"];

/** Application history records. Adapters decode native transcripts into these before they leave the provider. */
export type HistoryItem =
  | { id: string; type: "user_message"; content: HistoryContentPart[] }
  | { id: string; type: "assistant_message"; text: string; phase?: import("./events.js").MessagePhase }
  | { id: string; type: "plan"; text: string }
  | { id: string; type: "reasoning"; summary: string[] }
  | { id: string; type: "activity"; activity: HistoryActivity; output?: string }
  | { id: string; type: "image"; image: HistoryImage; activity?: HistoryActivity }
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

export interface ListThreadItemsResponse {
  data: Array<{ turnId: string; item: HistoryItem }>;
  nextCursor: string | null;
  backwardsCursor: string | null;
}
