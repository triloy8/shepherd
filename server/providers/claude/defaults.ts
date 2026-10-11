import { claudeEffortLevels, isClaudeEffort, type ClaudeEffort } from "./thread_store.js";

/** Defaults for new Shepherd conversations, independent of Codex configuration. */
export function claudeDefaults(environment: Record<string, string | undefined> = process.env): { model: string; effort: ClaudeEffort } {
  const effort = environment.CLAUDE_EFFORT?.trim() || "medium";
  if (!isClaudeEffort(effort)) throw new Error(`CLAUDE_EFFORT must be one of ${claudeEffortLevels.join(", ")}.`);
  return { model: environment.CLAUDE_MODEL?.trim() || "claude-opus-5-5", effort };
}
