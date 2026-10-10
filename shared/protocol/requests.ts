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
  baseInstructions?: string;
  developerInstructions?: string;
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
  source: string | null;
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
  baseInstructions?: string;
  developerInstructions?: string;
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
  baseInstructions?: string;
  developerInstructions?: string;
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
  modelProvider?: string;
  source?: string | null;
  turns?: HistoryTurn[];
}

export interface ListApprovalsResponse {
  approvals: ApprovalRecord[];
}

export interface ApprovalDecisionApiRequest extends ApprovalDecisionRequest {}

export interface ApprovalDecisionApiResponse {
  ok: true;
}

export interface TokenUsageBreakdown {
  cachedInputTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface ThreadTokenUsage {
  last: TokenUsageBreakdown;
  total: TokenUsageBreakdown;
  modelContextWindow?: number | null;
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

export interface ModelSummary {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
  supportedReasoningEfforts?: Array<{ reasoningEffort: string; description: string }>;
  defaultReasoningEffort?: string | null;
}

export interface ListModelsResponse {
  data: ModelSummary[];
  nextCursor: string | null;
}

export interface ThreadModelState {
  threadId: string;
  currentModel: string | null;
  modelProvider: string | null;
  pendingModel: string | null;
}

export type SkillScope = "user" | "repo" | "system" | "admin";

export interface SkillsListRequest {
  cwds?: string[];
  forceReload?: boolean;
}

export interface SkillToolDependency {
  type: string;
  value: string;
  command?: string | null;
  description?: string | null;
  transport?: string | null;
  url?: string | null;
}

export interface SkillDependencies {
  tools: SkillToolDependency[];
}

export interface SkillInterface {
  brandColor?: string | null;
  defaultPrompt?: string | null;
  displayName?: string | null;
  iconLarge?: string | null;
  iconSmall?: string | null;
  shortDescription?: string | null;
}

export interface SkillMetadata {
  dependencies?: SkillDependencies | null;
  description: string;
  enabled: boolean;
  interface?: SkillInterface | null;
  name: string;
  path: string;
  scope: SkillScope;
  shortDescription?: string | null;
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
  supportedEfforts: Array<{ reasoningEffort: string; description: string }>;
}

export interface ListThreadTurnsRequest {
  cursor?: string;
  limit?: number;
  sortDirection?: SortDirection;
  itemsView?: "notLoaded" | "summary" | "full";
}

export interface HistoryItem {
  id: string;
  type: string;
  text?: string;
  phase?: import("./events.js").MessagePhase;
  content?: Array<{ type: string; text?: string; url?: string; path?: string; name?: string }>;
  summary?: string[];
  activity?: import("./events.js").TurnActivityEvent["payload"];
  image?: { itemId: string; turnId: string | null; path: string; revisedPrompt?: string | null; kind: "generated" | "viewed" };
}

export interface HistoryTurn {
  id: string;
  items: HistoryItem[];
  itemsView: "notLoaded" | "summary" | "full";
  status: "completed" | "interrupted" | "failed" | "inProgress";
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
