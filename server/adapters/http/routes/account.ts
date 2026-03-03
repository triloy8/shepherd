import type { ConversationService } from "../../../core/conversation_service.js";
import { respondError, respondJson } from "./utils.js";

export async function handleGetAccountRateLimits(conversation: ConversationService): Promise<Response> {
  try {
    const result = await conversation.readAccountRateLimits();
    return respondJson(200, result);
  } catch (error) {
    return respondError(400, error instanceof Error ? error.message : "Failed to read account rate limits.");
  }
}
