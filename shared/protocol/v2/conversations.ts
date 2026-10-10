import type { BoundedText, ConversationInput, ConversationItem, ConversationTurn, InputMedia, InputPart } from "./conversation_items.js";

export type ProviderId = string;
export type ApprovalMode = "provider_default" | "review_sensitive" | "review_all" | "bypass";
export type SandboxMode = "read_only" | "workspace_write" | "unrestricted";

export interface ProviderCapabilities {
  fork: boolean;
  steering: boolean;
  compact: boolean;
  revert: boolean;
  skills: { list: boolean; configure: boolean };
  resets: boolean;
  questions: boolean;
  backgroundWork: boolean;
  inputKinds: Array<InputPart["type"]>;
  inputMedia: InputMedia[];
  approvalModes: ApprovalMode[];
  sandboxModes: SandboxMode[];
}

export interface ProviderDescriptor {
  id: ProviderId;
  displayName: string;
  capabilities: ProviderCapabilities;
  defaults: Pick<ThreadSettings, "approvalMode" | "sandboxMode">;
}
export interface ThreadSettings {
  cwd: string;
  model: string | null;
  effort: string | null;
  approvalMode: ApprovalMode;
  sandboxMode: SandboxMode;
}
export interface ThreadRecord {
  id: string;
  provider: ProviderId;
  name: string | null;
  preview: BoundedText;
  cwd: string;
  createdAt: number | null;
  updatedAt: number | null;
  archived: boolean;
}
export interface ThreadBootstrapInfo {
  thread: ThreadRecord;
  sessionId: string;
  settings: ThreadSettings;
  capabilities: ProviderCapabilities;
}
export interface ThreadOptions {
  settings: ThreadSettings;
  instructions: { base: string | null; additional: string | null };
}
export interface CreateThreadRequest extends ThreadOptions { provider: ProviderId }
export type ResumeThreadRequest = ThreadOptions;
export type ForkThreadRequest = ThreadOptions;
export interface TurnInput {
  input: ConversationInput;
  approvalMode?: ApprovalMode;
  model?: string;
  cwd?: string;
  effort?: string;
}
export interface ModelSummary {
  id: string;
  displayName: string;
  description: string | null;
  efforts: Array<{ id: string; label: string }>;
  defaultEffort: string | null;
}
export interface TokenUsage {
  last: { inputTokens: number; outputTokens: number; cachedInputTokens: number; reasoningOutputTokens: number; totalTokens: number };
  total: { inputTokens: number; outputTokens: number; cachedInputTokens: number; reasoningOutputTokens: number; totalTokens: number };
  modelContextWindow: number | null;
}
export interface Page<T> { data: T[]; nextCursor: string | null; backwardsCursor: string | null }
export interface HistoryPage extends Page<{ turnId: string; item: ConversationItem }> { historyRevision: string }
export interface TurnPage extends Page<ConversationTurn> { historyRevision: string }
export interface ThreadFilter {
  cwd?: string;
  archived?: boolean;
  search?: string;
  order?: "created" | "updated";
  cursor?: string;
}
export interface RevertThreadResponse { thread: ThreadRecord; historyRevision: string }

export interface SkillSummary { referenceId: string; name: string; description: string; enabled: boolean }
export interface SkillList { skills: SkillSummary[]; warnings: string[]; omitted: number }
