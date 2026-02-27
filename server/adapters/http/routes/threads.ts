import {
  validateCreateThreadRequest,
  validateForkThreadRequest,
  validateListLoadedThreadsRequest,
  validateListStoredThreadsRequest,
  validateReadThreadRequest,
  validateResumeThreadRequest,
  validateRollbackThreadRequest,
  validateSetThreadNameRequest,
} from "../../../../shared/protocol/validation.js";
import type { SessionManager } from "../../../core/session_manager.js";
import { parseJsonBody, respondError, respondJson } from "./utils.js";

function parseQuery(url: URL): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of url.searchParams.entries()) {
    if (key in result) {
      const current = result[key];
      if (Array.isArray(current)) {
        current.push(value);
      } else {
        result[key] = [current, value];
      }
      continue;
    }
    result[key] = value;
  }
  return result;
}

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

export async function handleListStoredThreads(request: Request, manager: SessionManager): Promise<Response> {
  try {
    const payload = validateListStoredThreadsRequest(parseQuery(new URL(request.url)));
    const result = await manager.listStoredThreads(payload);
    return respondJson(200, result);
  } catch (error) {
    return respondError(400, error instanceof Error ? error.message : "Failed to list stored threads.");
  }
}

export async function handleListLoadedThreads(request: Request, manager: SessionManager): Promise<Response> {
  try {
    const payload = validateListLoadedThreadsRequest(parseQuery(new URL(request.url)));
    const result = await manager.listLoadedThreads(payload);
    return respondJson(200, result);
  } catch (error) {
    return respondError(400, error instanceof Error ? error.message : "Failed to list loaded threads.");
  }
}

export function handleGetThread(manager: SessionManager, threadId: string): Response {
  try {
    return respondJson(200, manager.getThreadState(threadId));
  } catch (error) {
    return respondError(404, error instanceof Error ? error.message : "Thread not found.");
  }
}

export async function handleReadThread(
  request: Request,
  manager: SessionManager,
  threadId: string,
): Promise<Response> {
  try {
    const payload = validateReadThreadRequest(parseQuery(new URL(request.url)));
    const result = await manager.readThread(threadId, payload);
    return respondJson(200, result);
  } catch (error) {
    return respondError(400, error instanceof Error ? error.message : "Failed to read thread.");
  }
}

export async function handleResumeThread(
  request: Request,
  manager: SessionManager,
  threadId: string,
): Promise<Response> {
  try {
    const payload = validateResumeThreadRequest(await parseJsonBody(request));
    const result = await manager.resumeThread(threadId, payload);
    return respondJson(200, result);
  } catch (error) {
    return respondError(400, error instanceof Error ? error.message : "Failed to resume thread.");
  }
}

export async function handleForkThread(
  request: Request,
  manager: SessionManager,
  threadId: string,
): Promise<Response> {
  try {
    const payload = validateForkThreadRequest(await parseJsonBody(request));
    const result = await manager.forkThread(threadId, payload);
    return respondJson(200, result);
  } catch (error) {
    return respondError(400, error instanceof Error ? error.message : "Failed to fork thread.");
  }
}

export async function handleSetThreadName(
  request: Request,
  manager: SessionManager,
  threadId: string,
): Promise<Response> {
  try {
    const payload = validateSetThreadNameRequest(await parseJsonBody(request));
    const result = await manager.setThreadName(threadId, payload);
    return respondJson(200, result);
  } catch (error) {
    return respondError(400, error instanceof Error ? error.message : "Failed to set thread name.");
  }
}

export async function handleArchiveThread(manager: SessionManager, threadId: string): Promise<Response> {
  try {
    const result = await manager.archiveThread(threadId);
    return respondJson(200, result);
  } catch (error) {
    return respondError(400, error instanceof Error ? error.message : "Failed to archive thread.");
  }
}

export async function handleUnarchiveThread(manager: SessionManager, threadId: string): Promise<Response> {
  try {
    const result = await manager.unarchiveThread(threadId);
    return respondJson(200, result);
  } catch (error) {
    return respondError(400, error instanceof Error ? error.message : "Failed to unarchive thread.");
  }
}

export async function handleCompactThread(manager: SessionManager, threadId: string): Promise<Response> {
  try {
    const result = await manager.compactThread(threadId);
    return respondJson(200, result);
  } catch (error) {
    return respondError(400, error instanceof Error ? error.message : "Failed to compact thread.");
  }
}

export async function handleRollbackThread(
  request: Request,
  manager: SessionManager,
  threadId: string,
): Promise<Response> {
  try {
    const payload = validateRollbackThreadRequest(await parseJsonBody(request));
    const result = await manager.rollbackThread(threadId, payload);
    return respondJson(200, result);
  } catch (error) {
    return respondError(400, error instanceof Error ? error.message : "Failed to rollback thread.");
  }
}
