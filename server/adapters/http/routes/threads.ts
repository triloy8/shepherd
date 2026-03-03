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
import type { ConversationService } from "../../../core/conversation_service.js";
import type { SandboxMode } from "../../../../shared/protocol/requests.js";
import { parseJsonBody, respondError, respondJson } from "./utils.js";

const CODEX_CONTEXT_BASELINE_TOKENS = 12_000;
const SANDBOX_MODES: SandboxMode[] = ["read-only", "workspace-write", "danger-full-access"];

function readDefaultSandbox(): SandboxMode | undefined {
  const raw = process.env.CODEX_SANDBOX;
  if (!raw) return undefined;
  if (SANDBOX_MODES.includes(raw as SandboxMode)) {
    return raw as SandboxMode;
  }
  return undefined;
}

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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export async function handleCreateThread(
  request: Request,
  conversation: ConversationService,
): Promise<Response> {
  try {
    const payload = validateCreateThreadRequest(await parseJsonBody(request));
    payload.sandbox = payload.sandbox ?? readDefaultSandbox();
    const result = await conversation.createThread(payload);
    return respondJson(200, result);
  } catch (error) {
    return respondError(400, error instanceof Error ? error.message : "Failed to create thread.");
  }
}

export async function handleListStoredThreads(request: Request, conversation: ConversationService): Promise<Response> {
  try {
    const payload = validateListStoredThreadsRequest(parseQuery(new URL(request.url)));
    const result = await conversation.listStoredThreads(payload);
    return respondJson(200, result);
  } catch (error) {
    return respondError(400, error instanceof Error ? error.message : "Failed to list stored threads.");
  }
}

export async function handleListLoadedThreads(request: Request, conversation: ConversationService): Promise<Response> {
  try {
    const payload = validateListLoadedThreadsRequest(parseQuery(new URL(request.url)));
    const result = await conversation.listLoadedThreads(payload);
    return respondJson(200, result);
  } catch (error) {
    return respondError(400, error instanceof Error ? error.message : "Failed to list loaded threads.");
  }
}

export function handleGetThread(conversation: ConversationService, threadId: string): Response {
  try {
    return respondJson(200, conversation.getThreadState(threadId));
  } catch (error) {
    return respondError(404, error instanceof Error ? error.message : "Thread not found.");
  }
}

export async function handleGetThreadContext(conversation: ConversationService, threadId: string): Promise<Response> {
  try {
    const result = await conversation.readThreadTokenUsage(threadId);
    const usage = result.tokenUsage ? asRecord(result.tokenUsage) : null;
    const last = usage ? asRecord(usage.last) : null;
    const total = usage ? asRecord(usage.total) : null;
    const modelContextWindow = usage ? asNumber(usage.modelContextWindow) : null;

    const lastTotalTokens = last ? asNumber(last.totalTokens) : null;
    const effectiveWindow =
      modelContextWindow !== null ? Math.max(modelContextWindow - CODEX_CONTEXT_BASELINE_TOKENS, 0) : null;
    const usedInEffectiveWindow =
      effectiveWindow !== null && lastTotalTokens !== null
        ? Math.max(lastTotalTokens - CODEX_CONTEXT_BASELINE_TOKENS, 0)
        : null;
    const remainingInEffectiveWindow =
      effectiveWindow !== null && usedInEffectiveWindow !== null
        ? Math.max(effectiveWindow - usedInEffectiveWindow, 0)
        : null;
    const contextLeftPercent =
      effectiveWindow !== null && effectiveWindow > 0 && remainingInEffectiveWindow !== null
        ? Math.round((remainingInEffectiveWindow / effectiveWindow) * 100)
        : null;

    return respondJson(200, {
      threadId,
      baselineTokens: CODEX_CONTEXT_BASELINE_TOKENS,
      modelContextWindow,
      contextLeftPercent,
      effectiveRemainingTokens: remainingInEffectiveWindow,
      currentContextUsage: last,
      lifetimeCumulativeUsage: total,
      tokenUsage: result.tokenUsage,
    });
  } catch (error) {
    return respondError(400, error instanceof Error ? error.message : "Failed to read thread context.");
  }
}

export async function handleReadThread(
  request: Request,
  conversation: ConversationService,
  threadId: string,
): Promise<Response> {
  try {
    const payload = validateReadThreadRequest(parseQuery(new URL(request.url)));
    const result = await conversation.readThread(threadId, payload);
    return respondJson(200, result);
  } catch (error) {
    return respondError(400, error instanceof Error ? error.message : "Failed to read thread.");
  }
}

export async function handleResumeThread(
  request: Request,
  conversation: ConversationService,
  threadId: string,
): Promise<Response> {
  try {
    const payload = validateResumeThreadRequest(await parseJsonBody(request));
    const result = await conversation.resumeThread(threadId, payload);
    return respondJson(200, result);
  } catch (error) {
    return respondError(400, error instanceof Error ? error.message : "Failed to resume thread.");
  }
}

export async function handleForkThread(
  request: Request,
  conversation: ConversationService,
  threadId: string,
): Promise<Response> {
  try {
    const payload = validateForkThreadRequest(await parseJsonBody(request));
    const result = await conversation.forkThread(threadId, payload);
    return respondJson(200, result);
  } catch (error) {
    return respondError(400, error instanceof Error ? error.message : "Failed to fork thread.");
  }
}

export async function handleSetThreadName(
  request: Request,
  conversation: ConversationService,
  threadId: string,
): Promise<Response> {
  try {
    const payload = validateSetThreadNameRequest(await parseJsonBody(request));
    const result = await conversation.setThreadName(threadId, payload);
    return respondJson(200, result);
  } catch (error) {
    return respondError(400, error instanceof Error ? error.message : "Failed to set thread name.");
  }
}

export async function handleArchiveThread(conversation: ConversationService, threadId: string): Promise<Response> {
  try {
    const result = await conversation.archiveThread(threadId);
    return respondJson(200, result);
  } catch (error) {
    return respondError(400, error instanceof Error ? error.message : "Failed to archive thread.");
  }
}

export async function handleUnarchiveThread(conversation: ConversationService, threadId: string): Promise<Response> {
  try {
    const result = await conversation.unarchiveThread(threadId);
    return respondJson(200, result);
  } catch (error) {
    return respondError(400, error instanceof Error ? error.message : "Failed to unarchive thread.");
  }
}

export async function handleCompactThread(conversation: ConversationService, threadId: string): Promise<Response> {
  try {
    const result = await conversation.compactThread(threadId);
    return respondJson(200, result);
  } catch (error) {
    return respondError(400, error instanceof Error ? error.message : "Failed to compact thread.");
  }
}

export async function handleRollbackThread(
  request: Request,
  conversation: ConversationService,
  threadId: string,
): Promise<Response> {
  try {
    const payload = validateRollbackThreadRequest(await parseJsonBody(request));
    const result = await conversation.rollbackThread(threadId, payload);
    return respondJson(200, result);
  } catch (error) {
    return respondError(400, error instanceof Error ? error.message : "Failed to rollback thread.");
  }
}
