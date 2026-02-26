import { validateCreateThreadRequest } from "../../../../shared/protocol/validation.js";
import type { SessionManager } from "../../../core/session_manager.js";
import { parseJsonBody, respondError, respondJson } from "./utils.js";

export async function handleCreateThread(
  request: Request,
  manager: SessionManager,
): Promise<Response> {
  try {
    const payload = validateCreateThreadRequest(await parseJsonBody(request));
    const result = await manager.createThread(payload.approvalPolicy);
    return respondJson(200, result);
  } catch (error) {
    return respondError(400, error instanceof Error ? error.message : "Failed to create thread.");
  }
}

export function handleListThreads(manager: SessionManager): Response {
  return respondJson(200, manager.listThreads());
}

export function handleGetThread(manager: SessionManager, threadId: string): Response {
  try {
    return respondJson(200, manager.getThreadState(threadId));
  } catch (error) {
    return respondError(404, error instanceof Error ? error.message : "Thread not found.");
  }
}
