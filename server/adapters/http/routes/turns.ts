import {
  validateInterruptTurnRequest,
  validateSubmitTurnRequest,
} from "../../../../shared/protocol/validation.js";
import type { SessionManager } from "../../../core/session_manager.js";
import { parseJsonBody, respondError, respondJson } from "./utils.js";

export async function handleSubmitTurn(
  request: Request,
  manager: SessionManager,
  threadId: string,
): Promise<Response> {
  try {
    const payload = validateSubmitTurnRequest(await parseJsonBody(request));
    const result = await manager.submitTurn(threadId, payload);
    return respondJson(200, result);
  } catch (error) {
    return respondError(400, error instanceof Error ? error.message : "Failed to submit turn.");
  }
}

export async function handleInterruptTurn(
  request: Request,
  manager: SessionManager,
  threadId: string,
): Promise<Response> {
  try {
    const payload = validateInterruptTurnRequest(await parseJsonBody(request));
    await manager.interruptTurn(threadId, payload.turnId);
    return respondJson(200, { ok: true });
  } catch (error) {
    return respondError(400, error instanceof Error ? error.message : "Failed to interrupt turn.");
  }
}
