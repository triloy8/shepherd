import type * as P from "../../shared/protocol/requests.js";

export const claudeEffortLevels = ["low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeEffort = typeof claudeEffortLevels[number];
export const isClaudeEffort = (value: unknown): value is ClaudeEffort => claudeEffortLevels.includes(value as ClaudeEffort);

export type ClaudeThread = {
  id: string; nativeId: string; materialized: boolean; cwd: string; model: string;
  effort: ClaudeEffort | undefined; name: string | null; preview: string; archived: boolean;
  createdAt: number; updatedAt: number; instructions: string;
  turns: P.HistoryTurn[];
  tokenUsage?: P.ThreadTokenUsage;
};

/** Listing metadata. Reading it must not load conversation history. */
export type ClaudeThreadSummary = Omit<ClaudeThread, "turns" | "tokenUsage">;

export interface ClaudeThreadRepository {
  read(id: string): ClaudeThread;
  write(thread: ClaudeThread): void;
  list(): ClaudeThreadSummary[];
  hasThreads(): boolean;
}
