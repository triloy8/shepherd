import { validateApprovalDecisionRequest } from "../../../../shared/protocol/validation.js";
import type { SessionManager } from "../../../core/session_manager.js";
import { parseJsonBody, respondError, respondJson } from "./utils.js";

export function handleListApprovals(manager: SessionManager, threadId: string): Response {
  try {
    return respondJson(200, { approvals: manager.listApprovals(threadId) });
  } catch (error) {
    return respondError(404, error instanceof Error ? error.message : "Thread not found.");
  }
}

export async function handleApprovalDecision(
  request: Request,
  manager: SessionManager,
  threadId: string,
  approvalId: string,
): Promise<Response> {
  try {
    const payload = validateApprovalDecisionRequest(await parseJsonBody(request));
    await manager.applyApprovalDecision(threadId, approvalId, payload);
    return respondJson(200, { ok: true });
  } catch (error) {
    return respondError(400, error instanceof Error ? error.message : "Failed to submit approval decision.");
  }
}
