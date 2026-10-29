import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";

export const claudeEffortLevels = ["low", "medium", "high", "xhigh", "max"] as const satisfies readonly EffortLevel[];
export type ClaudeEffort = typeof claudeEffortLevels[number];
// The catalog reports the SDK's levels; an SDK upgrade that adds one must update this list, or
// core would accept a catalog effort that this adapter then rejects.
const sdkEffortsListed: Exclude<EffortLevel, ClaudeEffort> extends never ? true : never = true;
void sdkEffortsListed;
export const isClaudeEffort = (value: unknown): value is ClaudeEffort => claudeEffortLevels.includes(value as ClaudeEffort);

/** Defaults for new Shepherd conversations, independent of Codex configuration. */
export function claudeDefaults(environment: Record<string, string | undefined> = process.env): { model: string; effort: ClaudeEffort } {
  const effort = environment.CLAUDE_EFFORT?.trim() || "medium";
  if (!isClaudeEffort(effort)) throw new Error(`CLAUDE_EFFORT must be one of ${claudeEffortLevels.join(", ")}.`);
  return { model: environment.CLAUDE_MODEL?.trim() || "claude-opus-5-5", effort };
}

/** Whether Claude conversations may delegate to subagents through the Agent tool. */
export function claudeSubagentsEnabled(environment: Record<string, string | undefined> = process.env): boolean {
  const value = environment.CLAUDE_SUBAGENTS?.trim() || "enabled";
  if (value !== "enabled" && value !== "disabled") throw new Error("CLAUDE_SUBAGENTS must be enabled or disabled.");
  return value === "enabled";
}
