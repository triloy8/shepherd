import type { IncomingMessage, ServerResponse } from "node:http";

import { validateCreateThreadRequest } from "../../../../shared/protocol/validation.js";
import type { SessionManager } from "../../../core/session_manager.js";
import { parseJsonBody, respondError, respondJson } from "./utils.js";

export async function handleCreateThread(
  request: IncomingMessage,
  response: ServerResponse,
  manager: SessionManager,
): Promise<void> {
  try {
    const payload = validateCreateThreadRequest(await parseJsonBody(request));
    const result = await manager.createThread(payload.approvalPolicy);
    respondJson(response, 200, result);
  } catch (error) {
    respondError(response, 400, error instanceof Error ? error.message : "Failed to create thread.");
  }
}

export function handleListThreads(response: ServerResponse, manager: SessionManager): void {
  respondJson(response, 200, manager.listThreads());
}

export function handleGetThread(response: ServerResponse, manager: SessionManager, threadId: string): void {
  try {
    respondJson(response, 200, manager.getThreadState(threadId));
  } catch (error) {
    respondError(response, 404, error instanceof Error ? error.message : "Thread not found.");
  }
}
