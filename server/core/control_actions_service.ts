import type { ActionFailure } from "./action_error.js";
import type {
  AccountRateLimitsResponse,
  ListModelsResponse,
  ReadThreadTokenUsageResponse,
  ModelSummary,
  ReadThreadResponse,
  RollbackThreadResponse,
  SkillsConfigWriteResponse,
  SkillsListResponse,
  ThreadModelState,
  ThreadEffortState,
} from "../../shared/protocol/requests.js";
import { resolveSkillPathFromList } from "./skill_resolution_service.js";

type ControlConversation = {
  getThreadEffort: (threadId: string) => Promise<ThreadEffortState>;
  setThreadEffort: (threadId: string, effort: string) => Promise<ThreadEffortState>;
  listSkills: (threadId: string, request: Record<string, never>) => Promise<SkillsListResponse>;
  writeSkillConfig: (
    threadId: string,
    request: { path: string; enabled: boolean },
  ) => Promise<SkillsConfigWriteResponse>;
  listModels: (request: { cursor?: string; limit?: number; includeHidden?: boolean }) => Promise<ListModelsResponse>;
  getThreadModel: (threadId: string) => ThreadModelState;
  setThreadModel: (threadId: string, model: string) => ThreadModelState;
  readAccountRateLimits: () => Promise<AccountRateLimitsResponse>;
  readThreadTokenUsage: (threadId: string) => Promise<ReadThreadTokenUsageResponse>;
  setThreadName: (threadId: string, request: { name: string }) => Promise<{ ok: true }>;
  readThread: (threadId: string, request: { includeTurns: boolean }) => Promise<ReadThreadResponse>;
  archiveThread: (threadId: string) => Promise<{ ok: true }>;
  unarchiveThread: (threadId: string) => Promise<{ ok: true }>;
  rollbackThread: (threadId: string, request: { numTurns: number }) => Promise<RollbackThreadResponse>;
  compactThread: (threadId: string) => Promise<{ ok: true }>;
  interruptTurn: (threadId: string) => Promise<void>;
};

export type ControlActionsContext = {
  conversation: ControlConversation;
  getSurfaceThreadId: (surfaceId: string) => string | null;
  getSurfaceProject: (surfaceId: string) => string | null;
  setSurfaceProject: (surfaceId: string, repoSlug: string) => Promise<{ repoSlug: string }>;
  createSurfaceThread?: (surfaceId: string) => Promise<string>;
  switchSurfaceThread?: (surfaceId: string, threadId: string) => Promise<string>;
  forkSurfaceThread?: (surfaceId: string, sourceThreadId: string) => Promise<string>;
  clearSurfaceThread?: (surfaceId: string) => void;
};

export type ControlActionRequest =
  | { type: "effort.get"; surfaceId: string }
  | { type: "effort.set"; surfaceId: string; effort: string }
  | { type: "repo.get"; surfaceId: string }
  | { type: "repo.set"; surfaceId: string; repoInput: string }
  | { type: "limits.read" }
  | { type: "models.list"; surfaceId: string; cursor?: string; limit?: number }
  | { type: "model.set"; surfaceId: string; requestedModel: string }
  | { type: "context.read"; surfaceId: string }
  | { type: "skill.set-enabled"; surfaceId: string; requestedSkill: string; enabled: boolean }
  | { type: "thread.get-current"; surfaceId: string }
  | { type: "thread.create"; surfaceId: string }
  | { type: "thread.switch"; surfaceId: string; threadId: string }
  | { type: "thread.rename"; surfaceId: string; name: string }
  | { type: "thread.read"; surfaceId: string; threadId?: string }
  | { type: "thread.fork"; surfaceId: string; sourceThreadId?: string }
  | { type: "thread.archive"; surfaceId: string; threadId?: string }
  | { type: "thread.unarchive"; threadId: string }
  | { type: "thread.rollback"; surfaceId: string; numTurns: number; threadId?: string }
  | { type: "thread.compact"; surfaceId: string; threadId?: string }
  | { type: "turn.interrupt"; surfaceId: string };

export type ControlActionResult =
  | { type: "effort.get" | "effort.set"; ok: true; state: ThreadEffortState }
  | { type: "effort.get" | "effort.set"; ok: false; error: ActionFailure }
  | { type: "repo.get"; currentRepo: string | null }
  | { type: "repo.set"; repoSlug: string; activeThreadId: string | null }
  | { type: "limits.read"; rateLimits: unknown }
  | { type: "models.list"; models: ListModelsResponse; modelState: ThreadModelState | null }
  | { type: "model.set"; ok: true; threadId: string; model: string }
  | { type: "model.set"; ok: false; error: ActionFailure }
  | { type: "context.read"; ok: true; threadId: string; tokenUsage: ReadThreadTokenUsageResponse["tokenUsage"] }
  | { type: "context.read"; ok: false; error: ActionFailure }
  | { type: "skill.set-enabled"; ok: true; requestedSkill: string; enabled: boolean; effectiveEnabled: boolean }
  | { type: "skill.set-enabled"; ok: false; error: ActionFailure }
  | { type: "thread.get-current"; threadId: string | null }
  | { type: "thread.create"; threadId: string }
  | { type: "thread.switch"; threadId: string }
  | { type: "thread.rename"; ok: true; threadId: string; name: string }
  | { type: "thread.rename"; ok: false; error: ActionFailure }
  | { type: "thread.read"; ok: true; threadId: string; thread: ReadThreadResponse["thread"] }
  | { type: "thread.read"; ok: false; error: ActionFailure }
  | { type: "thread.fork"; ok: true; threadId: string; sourceThreadId: string }
  | { type: "thread.fork"; ok: false; error: ActionFailure }
  | { type: "thread.archive"; ok: true; threadId: string; clearedActiveBinding: boolean }
  | { type: "thread.archive"; ok: false; error: ActionFailure }
  | { type: "thread.unarchive"; ok: true; threadId: string }
  | { type: "thread.rollback"; ok: true; threadId: string; numTurns: number }
  | { type: "thread.rollback"; ok: false; error: ActionFailure }
  | { type: "thread.compact"; ok: true; threadId: string }
  | { type: "thread.compact"; ok: false; error: ActionFailure }
  | { type: "turn.interrupt"; ok: true; threadId: string }
  | { type: "turn.interrupt"; ok: false; error: ActionFailure };

function resolveModelArgument(models: ModelSummary[], raw: string): ModelSummary | null {
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return null;
  return (
    models.find((entry) => entry.model.toLowerCase() === normalized) ??
    models.find((entry) => entry.id.toLowerCase() === normalized) ??
    null
  );
}

export async function executeControlAction(
  context: ControlActionsContext,
  request: ControlActionRequest,
): Promise<ControlActionResult> {
  if (request.type === "effort.get" || request.type === "effort.set") {
    const threadId = context.getSurfaceThreadId(request.surfaceId);
    if (!threadId) return { type: request.type, ok: false, error: { code: "thread_required" } };
    const state = request.type === "effort.set"
      ? await context.conversation.setThreadEffort(threadId, request.effort)
      : await context.conversation.getThreadEffort(threadId);
    return { type: request.type, ok: true, state };
  }

  if (request.type === "repo.get") {
    return {
      type: "repo.get",
      currentRepo: context.getSurfaceProject(request.surfaceId),
    };
  }

  if (request.type === "repo.set") {
    const configured = await context.setSurfaceProject(request.surfaceId, request.repoInput);
    return {
      type: "repo.set",
      repoSlug: configured.repoSlug,
      activeThreadId: context.getSurfaceThreadId(request.surfaceId),
    };
  }

  if (request.type === "limits.read") {
    const result = await context.conversation.readAccountRateLimits();
    return {
      type: "limits.read",
      rateLimits: result.rateLimits,
    };
  }

  if (request.type === "models.list") {
    const threadId = context.getSurfaceThreadId(request.surfaceId);
    const models = await context.conversation.listModels({
      cursor: request.cursor,
      limit: request.limit ?? 20,
    });
    return {
      type: "models.list",
      models,
      modelState: threadId ? context.conversation.getThreadModel(threadId) : null,
    };
  }

  if (request.type === "model.set") {
    const threadId = context.getSurfaceThreadId(request.surfaceId);
    if (!threadId) {
      return {
        type: "model.set",
        ok: false,
        error: { code: "thread_required" },
      };
    }

    let cursor: string | undefined;
    let resolved: ModelSummary | null = null;
    const seenCursors = new Set<string>();
    do {
      const models = await context.conversation.listModels({ cursor, limit: 100, includeHidden: true });
      resolved = resolveModelArgument(models.data, request.requestedModel);
      if (resolved || !models.nextCursor || seenCursors.has(models.nextCursor)) break;
      seenCursors.add(models.nextCursor);
      cursor = models.nextCursor;
    } while (true);
    if (!resolved) {
      return {
        type: "model.set",
        ok: false,
        error: { code: "unknown_model", requestedModel: request.requestedModel },
      };
    }

    const updated = context.conversation.setThreadModel(threadId, resolved.model);
    return {
      type: "model.set",
      ok: true,
      threadId: updated.threadId,
      model: resolved.model,
    };
  }

  if (request.type === "context.read") {
    const threadId = context.getSurfaceThreadId(request.surfaceId);
    if (!threadId) {
      return {
        type: "context.read",
        ok: false,
        error: { code: "thread_required" },
      };
    }
    const result = await context.conversation.readThreadTokenUsage(threadId);
    return {
      type: "context.read",
      ok: true,
      threadId,
      tokenUsage: result.tokenUsage,
    };
  }

  if (request.type === "thread.get-current") {
    return {
      type: "thread.get-current",
      threadId: context.getSurfaceThreadId(request.surfaceId),
    };
  }

  if (request.type === "thread.create") {
    if (!context.createSurfaceThread) {
      throw new Error("Surface thread creation is not configured.");
    }
    return {
      type: "thread.create",
      threadId: await context.createSurfaceThread(request.surfaceId),
    };
  }

  if (request.type === "thread.switch") {
    if (!context.switchSurfaceThread) {
      throw new Error("Surface thread switching is not configured.");
    }
    return {
      type: "thread.switch",
      threadId: await context.switchSurfaceThread(request.surfaceId, request.threadId),
    };
  }

  if (request.type === "thread.rename") {
    const threadId = context.getSurfaceThreadId(request.surfaceId);
    if (!threadId) {
      return {
        type: "thread.rename",
        ok: false,
        error: { code: "thread_required" },
      };
    }
    await context.conversation.setThreadName(threadId, { name: request.name });
    return {
      type: "thread.rename",
      ok: true,
      threadId,
      name: request.name,
    };
  }

  if (request.type === "thread.read") {
    const threadId = request.threadId ?? context.getSurfaceThreadId(request.surfaceId);
    if (!threadId) {
      return {
        type: "thread.read",
        ok: false,
        error: { code: "thread_required" },
      };
    }
    const result = await context.conversation.readThread(threadId, { includeTurns: false });
    return {
      type: "thread.read",
      ok: true,
      threadId,
      thread: result.thread,
    };
  }

  if (request.type === "thread.fork") {
    const sourceThreadId = request.sourceThreadId ?? context.getSurfaceThreadId(request.surfaceId);
    if (!sourceThreadId) {
      return {
        type: "thread.fork",
        ok: false,
        error: { code: "thread_required" },
      };
    }
    if (!context.forkSurfaceThread) {
      throw new Error("Surface thread forking is not configured.");
    }
    return {
      type: "thread.fork",
      ok: true,
      threadId: await context.forkSurfaceThread(request.surfaceId, sourceThreadId),
      sourceThreadId,
    };
  }

  if (request.type === "thread.archive") {
    const threadId = request.threadId ?? context.getSurfaceThreadId(request.surfaceId);
    if (!threadId) {
      return {
        type: "thread.archive",
        ok: false,
        error: { code: "thread_required" },
      };
    }
    await context.conversation.archiveThread(threadId);
    const clearedActiveBinding = context.getSurfaceThreadId(request.surfaceId) === threadId;
    if (clearedActiveBinding) {
      context.clearSurfaceThread?.(request.surfaceId);
    }
    return {
      type: "thread.archive",
      ok: true,
      threadId,
      clearedActiveBinding,
    };
  }

  if (request.type === "thread.unarchive") {
    await context.conversation.unarchiveThread(request.threadId);
    return {
      type: "thread.unarchive",
      ok: true,
      threadId: request.threadId,
    };
  }

  if (request.type === "thread.rollback") {
    const threadId = request.threadId ?? context.getSurfaceThreadId(request.surfaceId);
    if (!Number.isInteger(request.numTurns) || request.numTurns < 1 || !threadId) {
      return {
        type: "thread.rollback",
        ok: false,
        error: { code: !threadId ? "thread_required" : "invalid_turn_count" },
      };
    }
    await context.conversation.rollbackThread(threadId, { numTurns: request.numTurns });
    return {
      type: "thread.rollback",
      ok: true,
      threadId,
      numTurns: request.numTurns,
    };
  }

  if (request.type === "thread.compact") {
    const threadId = request.threadId ?? context.getSurfaceThreadId(request.surfaceId);
    if (!threadId) {
      return {
        type: "thread.compact",
        ok: false,
        error: { code: "thread_required" },
      };
    }
    await context.conversation.compactThread(threadId);
    return {
      type: "thread.compact",
      ok: true,
      threadId,
    };
  }

  if (request.type === "turn.interrupt") {
    const threadId = context.getSurfaceThreadId(request.surfaceId);
    if (!threadId) {
      return {
        type: "turn.interrupt",
        ok: false,
        error: { code: "thread_required" },
      };
    }
    await context.conversation.interruptTurn(threadId);
    return {
      type: "turn.interrupt",
      ok: true,
      threadId,
    };
  }

  const threadId = context.getSurfaceThreadId(request.surfaceId);
  if (!threadId) {
    return {
      type: "skill.set-enabled",
      ok: false,
      error: { code: "thread_required" },
    };
  }

  const listed = await context.conversation.listSkills(threadId, {});
  const resolved = resolveSkillPathFromList(listed, request.requestedSkill);
  if ("error" in resolved) {
    return {
      type: "skill.set-enabled",
      ok: false,
      error: resolved.error,
    };
  }

  const result = await context.conversation.writeSkillConfig(threadId, {
    path: resolved.path,
    enabled: request.enabled,
  });
  return {
    type: "skill.set-enabled",
    ok: true,
    requestedSkill: request.requestedSkill,
    enabled: request.enabled,
    effectiveEnabled: result.effectiveEnabled,
  };
}
