import type { IncomingMessage, ServerResponse } from "node:http";

import {
  validateInterruptTurnRequest,
  validateSubmitTurnRequest,
} from "../../../../shared/protocol/validation.js";
import type { SessionManager } from "../../../core/session_manager.js";
import { parseJsonBody, respondError, respondJson } from "./utils.js";

export async function handleSubmitTurn(
  request: IncomingMessage,
  response: ServerResponse,
  manager: SessionManager,
  threadId: string,
): Promise<void> {
  try {
    const payload = validateSubmitTurnRequest(await parseJsonBody(request));
    const result = await manager.submitTurn(threadId, payload);
    respondJson(response, 200, result);
  } catch (error) {
    respondError(response, 400, error instanceof Error ? error.message : "Failed to submit turn.");
  }
}

export async function handleInterruptTurn(
  request: IncomingMessage,
  response: ServerResponse,
  manager: SessionManager,
  threadId: string,
): Promise<void> {
  try {
    const payload = validateInterruptTurnRequest(await parseJsonBody(request));
    await manager.interruptTurn(threadId, payload.turnId);
    respondJson(response, 200, { ok: true });
  } catch (error) {
    respondError(response, 400, error instanceof Error ? error.message : "Failed to interrupt turn.");
  }
}
