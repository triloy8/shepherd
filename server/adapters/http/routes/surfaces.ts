import {
  validateBindSurfaceThreadRequest,
  validateCreateSurfaceThreadRequest,
  validateForkSurfaceThreadRequest,
  validateInterruptTurnRequest,
  validateResumeSurfaceThreadRequest,
  validateSetSurfaceWorkspaceTargetRequest,
  validateSetThreadModelRequest,
  validateSubmitSurfaceTurnRequest,
} from "../../../../shared/protocol/validation.js";
import type { ConversationService } from "../../../core/conversation_service.js";
import { parseJsonBody, respondError, respondJson } from "./utils.js";
import { handleGetThreadContext } from "./threads.js";

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

export function handleGetSurfaceWorkspaceTarget(
  conversation: ConversationService,
  adapter: string,
  surfaceId: string,
): Response {
  try {
    return respondJson(200, { target: conversation.getSurfaceWorkspaceTarget(adapter, surfaceId) });
  } catch (error) {
    return respondError(400, error instanceof Error ? error.message : "Failed to read workspace target.");
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

export function handleClearSurfaceWorkspaceTarget(
  conversation: ConversationService,
  adapter: string,
  surfaceId: string,
): Response {
  try {
    conversation.clearSurfaceWorkspaceTarget(adapter, surfaceId);
    return respondJson(200, { ok: true });
  } catch (error) {
    return respondError(400, error instanceof Error ? error.message : "Failed to clear workspace target.");
  }
}

export async function handleBindSurfaceThread(
  request: Request,
  conversation: ConversationService,
  adapter: string,
  surfaceId: string,
): Promise<Response> {
  try {
    const payload = validateBindSurfaceThreadRequest(await parseJsonBody(request));
    const threadId = await conversation.bindSurfaceToThread(adapter, surfaceId, payload.threadId);
    return respondJson(200, { threadId });
  } catch (error) {
    return respondError(400, error instanceof Error ? error.message : "Failed to bind surface thread.");
  }
}

export function handleClearSurfaceThread(
  conversation: ConversationService,
  adapter: string,
  surfaceId: string,
): Response {
  try {
    conversation.clearSurfaceBinding(adapter, surfaceId);
    return respondJson(200, { ok: true });
  } catch (error) {
    return respondError(400, error instanceof Error ? error.message : "Failed to clear surface thread.");
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

export async function handleGetSurfaceContext(
  conversation: ConversationService,
  adapter: string,
  surfaceId: string,
): Promise<Response> {
  try {
    const threadId = conversation.getSurfaceState(adapter, surfaceId).activeThreadId;
    if (!threadId) {
      return respondError(404, "No active thread for this surface.");
    }
    return handleGetThreadContext(conversation, threadId);
  } catch (error) {
    return respondError(400, error instanceof Error ? error.message : "Failed to read surface context.");
  }
}

export function handleGetSurfaceModel(
  conversation: ConversationService,
  adapter: string,
  surfaceId: string,
): Response {
  try {
    return respondJson(200, conversation.getSurfaceModel(adapter, surfaceId));
  } catch (error) {
    return respondError(404, error instanceof Error ? error.message : "No active thread for this surface.");
  }
}

export async function handleSetSurfaceModel(
  request: Request,
  conversation: ConversationService,
  adapter: string,
  surfaceId: string,
): Promise<Response> {
  try {
    const payload = validateSetThreadModelRequest(await parseJsonBody(request));
    return respondJson(200, conversation.setSurfaceModel(adapter, surfaceId, payload));
  } catch (error) {
    return respondError(400, error instanceof Error ? error.message : "Failed to set surface model.");
  }
}

export async function handleInterruptSurfaceTurn(
  request: Request,
  conversation: ConversationService,
  adapter: string,
  surfaceId: string,
): Promise<Response> {
  try {
    const payload = validateInterruptTurnRequest(await parseJsonBody(request));
    await conversation.interruptSurfaceTurn(adapter, surfaceId, payload.turnId);
    return respondJson(200, { ok: true });
  } catch (error) {
    return respondError(400, error instanceof Error ? error.message : "Failed to interrupt surface turn.");
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
