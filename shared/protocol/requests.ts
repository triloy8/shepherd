import type { ApprovalDecisionRequest, ApprovalRecord } from "./approvals.js";

export type ApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type Personality = "none" | "friendly" | "pragmatic";
export type ThreadSortKey = "created_at" | "updated_at";
export type ThreadSourceKind =
  | "cli"
  | "vscode"
  | "exec"
  | "appServer"
  | "subAgent"
  | "subAgentReview"
  | "subAgentCompact"
  | "subAgentThreadSpawn"
  | "subAgentOther"
  | "unknown";

export interface CreateThreadRequest {
  approvalPolicy?: ApprovalPolicy;
  baseInstructions?: string;
  developerInstructions?: string;
  config?: Record<string, unknown>;
  cwd?: string;
  personality?: Personality;
  sandbox?: SandboxMode;
  model?: string;
  modelProvider?: string;
  ephemeral?: boolean;
  serviceName?: string;
}

export interface CreateThreadResponse {
  threadId: string;
  sessionId: string;
}

export interface SubmitTurnRequest {
  input: string;
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
  input: string;
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
  cwd?: string;
  limit?: number;
  modelProviders?: string[];
  searchTerm?: string;
  sortKey?: ThreadSortKey;
  sourceKinds?: ThreadSourceKind[];
}

export interface ListStoredThreadsResponse {
  threads: StoredThreadSummary[];
  nextCursor: string | null;
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
  approvalPolicy?: ApprovalPolicy;
  baseInstructions?: string;
  developerInstructions?: string;
  config?: Record<string, unknown>;
  cwd?: string;
  personality?: Personality;
  sandbox?: SandboxMode;
  model?: string;
  modelProvider?: string;
}

export interface ResumeThreadResponse {
  threadId: string;
  sessionId: string;
}

export interface ForkThreadRequest {
  approvalPolicy?: ApprovalPolicy;
  baseInstructions?: string;
  developerInstructions?: string;
  config?: Record<string, unknown>;
  cwd?: string;
  sandbox?: SandboxMode;
  model?: string;
  modelProvider?: string;
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

export interface RollbackThreadRequest {
  numTurns: number;
}

export interface RollbackThreadResponse {
  thread: ThreadRecord;
}

export interface ThreadRecord {
  id: string;
  name?: string | null;
  preview?: string;
  createdAt?: number;
  updatedAt?: number;
  cwd?: string;
  modelProvider?: string;
  source?: unknown;
  status?: unknown;
  turns?: unknown[];
  [key: string]: unknown;
}

export interface ListApprovalsResponse {
  approvals: ApprovalRecord[];
}

export interface ApprovalDecisionApiRequest extends ApprovalDecisionRequest {}

export interface ApprovalDecisionApiResponse {
  ok: true;
}

export interface AccountRateLimitsResponse {
  rateLimits: unknown;
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
  supportsPersonality: boolean;
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

export interface SkillsListExtraRootsForCwd {
  cwd: string;
  extraUserRoots: string[];
}

export interface SkillsListRequest {
  cwds?: string[];
  forceReload?: boolean;
  perCwdExtraUserRoots?: SkillsListExtraRootsForCwd[] | null;
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
