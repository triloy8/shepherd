import { validateApprovalDecisionRequest } from "../../../../shared/protocol/validation.js";
import type { ConversationService } from "../../../core/conversation_service.js";
import { parseJsonBody, respondError, respondJson } from "./utils.js";

export function handleListApprovals(conversation: ConversationService, threadId: string): Response {
  try {
    return respondJson(200, { approvals: conversation.listApprovals(threadId) });
  } catch (error) {
    return respondError(404, error instanceof Error ? error.message : "Thread not found.");
  }
}

export async function handleApprovalDecision(
  request: Request,
  conversation: ConversationService,
  threadId: string,
  approvalId: string,
): Promise<Response> {
  try {
    const payload = validateApprovalDecisionRequest(await parseJsonBody(request));
    await conversation.applyApprovalDecision(threadId, approvalId, payload);
    return respondJson(200, { ok: true });
  } catch (error) {
    return respondError(400, error instanceof Error ? error.message : "Failed to submit approval decision.");
  }
}
