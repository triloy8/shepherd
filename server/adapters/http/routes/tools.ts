import { respondError } from "./utils.js";

export function handleToolsNotImplemented(): Response {
  return respondError(501, "Tool routes are not implemented in this refactor.");
}
