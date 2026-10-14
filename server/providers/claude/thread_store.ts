import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeStoredTokenUsage, ClaudeStoredTurn } from "./history.js";
import type { ClaudeStoredApprovalMode } from "./permissions.js";

export const claudeEffortLevels = ["low", "medium", "high", "xhigh", "max"] as const satisfies readonly EffortLevel[];
export type ClaudeEffort = typeof claudeEffortLevels[number];
// The catalog reports the SDK's levels; an SDK upgrade that adds one must update this list, or
// core would accept a catalog effort that this adapter then rejects.
const sdkEffortsListed: Exclude<EffortLevel, ClaudeEffort> extends never ? true : never = true;
void sdkEffortsListed;
export const isClaudeEffort = (value: unknown): value is ClaudeEffort => claudeEffortLevels.includes(value as ClaudeEffort);

/** Saved snapshot. Every field is an adapter-owned value; history.ts presents it to the application. */
export type ClaudeThread = {
  id: string; nativeId: string; materialized: boolean; cwd: string; model: string;
  effort: ClaudeEffort | undefined; name: string | null; preview: string; archived: boolean;
  createdAt: number; updatedAt: number;
  /** Written by earlier versions; still appended to the preset prompt when present. */
  instructions?: string;
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
