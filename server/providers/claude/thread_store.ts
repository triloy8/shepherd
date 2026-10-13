import type { ClaudeStoredTokenUsage, ClaudeStoredTurn } from "./history.js";
import type { ClaudeStoredApprovalMode } from "./permissions.js";

export const claudeEffortLevels = ["low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeEffort = typeof claudeEffortLevels[number];
export const isClaudeEffort = (value: unknown): value is ClaudeEffort => claudeEffortLevels.includes(value as ClaudeEffort);

/** Saved snapshot. Every field is an adapter-owned value; history.ts presents it to the application. */
export type ClaudeThread = {
  id: string; nativeId: string; materialized: boolean; cwd: string; model: string;
  effort: ClaudeEffort | undefined; name: string | null; preview: string; archived: boolean;
  createdAt: number; updatedAt: number; instructions: string;
  turns: ClaudeStoredTurn[];
  tokenUsage?: ClaudeStoredTokenUsage;
  approvalMode?: ClaudeStoredApprovalMode;
};

/** Listing metadata. Reading it must not load conversation history. */
export type ClaudeThreadSummary = Omit<ClaudeThread, "turns" | "tokenUsage">;

export interface ClaudeThreadRepository {
  read(id: string): ClaudeThread;
  write(thread: ClaudeThread): void;
  list(): ClaudeThreadSummary[];
  hasThreads(): boolean;
}
