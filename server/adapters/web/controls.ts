import { executeControlAction, type ControlActionsContext, type ControlActionRequest } from "../../core/control_actions_service.js";
import { WebRequestError } from "./errors.js";

/** Shared semantics; this adapter only translates expected failures to HTTP. */
export async function webControl(context: ControlActionsContext, request: ControlActionRequest) {
  const result = await executeControlAction(context, request);
  if ("ok" in result && !result.ok) {
    const failure = result.error;
    const message = failure.code === "unknown_model" ? "This model is not available. Refresh the model list." :
      failure.code === "unsupported_effort" ? `Unsupported effort. Available levels: ${failure.available.join(", ") || "none"}.` :
      failure.code === "model_unavailable" ? "Settings for this model are unavailable. Refresh or choose another model." :
      "A conversation must be attached before this action.";
    throw new WebRequestError(failure.code === "unknown_model" || failure.code === "unsupported_effort" ? 400 : 409, failure.code, message);
  }
  return result;
}
