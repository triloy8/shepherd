import type { IncomingMessage, ServerResponse } from "node:http";

import { validateApprovalDecisionRequest } from "../../../../shared/protocol/validation.js";
import type { SessionManager } from "../../../core/session_manager.js";
import { parseJsonBody, respondError, respondJson } from "./utils.js";

export function handleListApprovals(response: ServerResponse, manager: SessionManager, threadId: string): void {
  try {
    respondJson(response, 200, { approvals: manager.listApprovals(threadId) });
  } catch (error) {
    respondError(response, 404, error instanceof Error ? error.message : "Thread not found.");
  }
}

export async function handleApprovalDecision(
  request: IncomingMessage,
  response: ServerResponse,
  manager: SessionManager,
  threadId: string,
  approvalId: string,
): Promise<void> {
  try {
    const payload = validateApprovalDecisionRequest(await parseJsonBody(request));
    await manager.applyApprovalDecision(threadId, approvalId, payload);
    respondJson(response, 200, { ok: true });
  } catch (error) {
    respondError(response, 400, error instanceof Error ? error.message : "Failed to submit approval decision.");
  }
}
