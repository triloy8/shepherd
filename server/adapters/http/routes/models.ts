import {
  validateListModelsRequest,
  validateSetThreadModelRequest,
} from "../../../../shared/protocol/validation.js";
import type { ConversationService } from "../../../core/conversation_service.js";
import { parseJsonBody, respondError, respondJson } from "./utils.js";

function parseQuery(url: URL): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of url.searchParams.entries()) {
    result[key] = value;
  }
  return result;
}

export async function handleListModels(request: Request, conversation: ConversationService): Promise<Response> {
  try {
    const payload = validateListModelsRequest(parseQuery(new URL(request.url)));
    const result = await conversation.listModels(payload);
    return respondJson(200, result);
  } catch (error) {
    return respondError(400, error instanceof Error ? error.message : "Failed to list models.");
  }
}

export function handleGetThreadModel(conversation: ConversationService, threadId: string): Response {
  try {
    return respondJson(200, conversation.getThreadModel(threadId));
  } catch (error) {
    return respondError(404, error instanceof Error ? error.message : "Thread not found.");
  }
}

export async function handleSetThreadModel(
  request: Request,
  conversation: ConversationService,
  threadId: string,
): Promise<Response> {
  try {
    const payload = validateSetThreadModelRequest(await parseJsonBody(request));
    const result = conversation.setThreadModelFromRequest(threadId, payload);
    return respondJson(200, result);
  } catch (error) {
    return respondError(400, error instanceof Error ? error.message : "Failed to set thread model.");
  }
}
