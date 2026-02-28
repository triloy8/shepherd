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
