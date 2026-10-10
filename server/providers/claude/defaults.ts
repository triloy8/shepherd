import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";

/** Defaults for new Shepherd conversations, independent of Codex configuration. */
export function claudeDefaults(environment: Record<string, string | undefined> = process.env): { model: string; effort: EffortLevel } {
  const effort = environment.CLAUDE_EFFORT?.trim() || "medium";
  if (!["low", "medium", "high", "xhigh", "max"].includes(effort)) throw new Error("CLAUDE_EFFORT must be low, medium, high, xhigh, or max.");
  return { model: environment.CLAUDE_MODEL?.trim() || "claude-opus-5-5", effort: effort as EffortLevel };
}
