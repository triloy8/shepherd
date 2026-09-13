import { ApplicationActionError, type ActionFailure } from "../../core/action_error.js";

export function formatActionFailure(error: ActionFailure): string {
  switch (error.code) {
    case "model_unavailable": return "The thread's model is not in the model catalog. Use !model set <id> first.";
    case "unsupported_effort": return `Unsupported effort for ${error.model}: ${error.requested}. Available: ${error.available.join(", ") || "none"}.`;
    case "thread_required": return "No active thread in this channel. Use `!newthread` or `!thread <id>` first.";
    case "project_required": return "No repo selected for this channel. Use `!repo <owner>/<repo>`, `!repo ~`, or `!repo ~/path` first.";
    case "invalid_turn_count": return "Usage: !rollback <numTurns> [id]";
    case "unknown_model": return `Unknown model: \`${error.requestedModel}\`. Use \`!models\` to inspect available models.`;
    case "invalid_skill": return "Invalid skill name or path.";
    case "skill_not_found": return `No loaded skill matches \`${error.requestedSkill}\`. Use \`!skills\` to inspect available names.`;
    case "skill_ambiguous": return `Multiple skills match \`${error.requestedSkill}\`: ${error.candidates.map(({ name, scope }) => `${name} [${scope}]`).join(", ")}. Use the full path.`;
  }
}

export function formatApplicationError(error: unknown, fallback: string): string {
  return error instanceof ApplicationActionError
    ? formatActionFailure(error.failure)
    : error instanceof Error ? error.message : fallback;
}
