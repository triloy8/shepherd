import type { ServerResponse } from "node:http";
import { respondError } from "./utils.js";

export function handleToolsNotImplemented(response: ServerResponse): void {
  respondError(response, 501, "Tool routes are not implemented in this refactor.");
}
