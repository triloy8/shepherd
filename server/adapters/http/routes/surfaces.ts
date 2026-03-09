import {
  validateCreateSurfaceThreadRequest,
  validateForkSurfaceThreadRequest,
  validateResumeSurfaceThreadRequest,
  validateSetSurfaceWorkspaceTargetRequest,
  validateSubmitSurfaceTurnRequest,
} from "../../../../shared/protocol/validation.js";
import type { ConversationService } from "../../../core/conversation_service.js";
import { parseJsonBody, respondError, respondJson } from "./utils.js";

export function handleGetSurfaceState(
  conversation: ConversationService,
  adapter: string,
  surfaceId: string,
): Response {
  try {
    return respondJson(200, conversation.getSurfaceState(adapter, surfaceId));
  } catch (error) {
    return respondError(400, error instanceof Error ? error.message : "Failed to read surface state.");
  }
}

export async function handleSetSurfaceWorkspaceTarget(
  request: Request,
  conversation: ConversationService,
  adapter: string,
  surfaceId: string,
): Promise<Response> {
  try {
    const payload = validateSetSurfaceWorkspaceTargetRequest(await parseJsonBody(request));
    const target = conversation.setSurfaceWorkspaceTarget(adapter, surfaceId, payload.target);
    return respondJson(200, { target });
  } catch (error) {
    return respondError(400, error instanceof Error ? error.message : "Failed to set workspace target.");
  }
}

export async function handleCreateSurfaceThread(
  request: Request,
  conversation: ConversationService,
  adapter: string,
  surfaceId: string,
): Promise<Response> {
  try {
    const payload = validateCreateSurfaceThreadRequest(await parseJsonBody(request));
    const result = await conversation.createSurfaceThreadFromContext(adapter, surfaceId, payload);
    return respondJson(200, result);
  } catch (error) {
    return respondError(400, error instanceof Error ? error.message : "Failed to create surface thread.");
  }
}

export async function handleResumeSurfaceThread(
  request: Request,
  conversation: ConversationService,
  adapter: string,
  surfaceId: string,
  threadId: string,
): Promise<Response> {
  try {
    const payload = validateResumeSurfaceThreadRequest(await parseJsonBody(request));
    const result = await conversation.resumeSurfaceThreadFromContext(adapter, surfaceId, threadId, payload);
    return respondJson(200, result);
  } catch (error) {
    return respondError(400, error instanceof Error ? error.message : "Failed to resume surface thread.");
  }
}

export async function handleForkSurfaceThread(
  request: Request,
  conversation: ConversationService,
  adapter: string,
  surfaceId: string,
  threadId: string,
): Promise<Response> {
  try {
    const payload = validateForkSurfaceThreadRequest(await parseJsonBody(request));
    const result = await conversation.forkSurfaceThreadFromContext(adapter, surfaceId, threadId, payload);
    return respondJson(200, result);
  } catch (error) {
    return respondError(400, error instanceof Error ? error.message : "Failed to fork surface thread.");
  }
}

export async function handleSubmitSurfaceTurn(
  request: Request,
  conversation: ConversationService,
  adapter: string,
  surfaceId: string,
): Promise<Response> {
  try {
    const payload = validateSubmitSurfaceTurnRequest(await parseJsonBody(request));
    const result = await conversation.submitSurfaceTurn(adapter, surfaceId, payload);
    return respondJson(200, result);
  } catch (error) {
    return respondError(400, error instanceof Error ? error.message : "Failed to submit surface turn.");
  }
}
