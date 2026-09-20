import { executeControlAction, type ControlActionsContext, type ControlActionRequest } from "../../core/control_actions_service.js";
import { WebRequestError } from "./errors.js";

/** Shared semantics; this adapter only translates expected failures to HTTP. */
export async function webControl(context: ControlActionsContext, request: ControlActionRequest) {
  const result = await executeControlAction(context, request);
  if ("ok" in result && !result.ok) {
    const failure = result.error;
    const message = failure.code === "invalid_skill" ? "Choose a skill name or path." :
      failure.code === "skill_not_found" ? "This skill was not found. Reload skills and try again." :
      failure.code === "skill_ambiguous" ? "More than one skill has this name. Choose a specific skill path." :
      failure.code === "unknown_model" ? "This model is not available. Refresh the model list." :
      failure.code === "unsupported_effort" ? `Unsupported effort. Available levels: ${failure.available.join(", ") || "none"}.` :
      failure.code === "model_unavailable" ? "Settings for this model are unavailable. Refresh or choose another model." :
      "A conversation must be attached before this action.";
    throw new WebRequestError(["unknown_model", "unsupported_effort", "invalid_skill", "skill_not_found", "skill_ambiguous"].includes(failure.code) ? 400 : 409, failure.code, message);
  }
  return result;
}
