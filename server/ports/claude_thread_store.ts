import type * as P from "../../shared/protocol/requests.js";

export type ClaudeThread = {
  id: string; nativeId: string; materialized: boolean; cwd: string; model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max" | undefined; name: string | null; preview: string; archived: boolean;
  createdAt: number; updatedAt: number; instructions: string;
  turns: P.HistoryTurn[];
  tokenUsage?: P.ThreadTokenUsage;
};

export interface ClaudeThreadRepository {
  read(id: string): ClaudeThread;
  write(thread: ClaudeThread): void;
  list(): ClaudeThread[];
}
