/** Expected application failures; adapters own their presentation. */
export type ActionFailure =
  | { code: "thread_required" }
  | { code: "project_required" }
  | { code: "invalid_turn_count" }
  | { code: "unknown_model"; requestedModel: string }
  | { code: "invalid_skill" }
  | { code: "skill_not_found"; requestedSkill: string }
  | { code: "skill_ambiguous"; requestedSkill: string; candidates: Array<{ name: string; scope: string; path: string }> };

export class ApplicationActionError extends Error {
  constructor(readonly failure: ActionFailure) {
    super(failure.code);
    this.name = "ApplicationActionError";
  }
}
