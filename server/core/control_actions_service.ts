import type {
  ListModelsResponse,
  ModelSummary,
  ReadThreadResponse,
  RollbackThreadResponse,
  SkillsConfigWriteResponse,
  SkillsListResponse,
  ThreadModelState,
} from "../../shared/protocol/requests.js";
import { resolveSkillPathFromList } from "./skill_resolution_service.js";

type ControlConversation = {
  listSkills: (threadId: string, request: Record<string, never>) => Promise<SkillsListResponse>;
  writeSkillConfig: (
    threadId: string,
    request: { path: string; enabled: boolean },
  ) => Promise<SkillsConfigWriteResponse>;
  listModels: (request: { limit?: number; includeHidden?: boolean }) => Promise<ListModelsResponse>;
  setThreadModel: (threadId: string, model: string) => ThreadModelState;
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
  getActiveThreadId: (channelId: string) => string | null;
  getChannelRepo: (channelId: string) => string | null;
  setChannelRepo: (channelId: string, repoSlug: string) => Promise<{ repoSlug: string }>;
  clearChannelThread?: (channelId: string) => void;
};

export type ControlActionRequest =
  | { type: "repo.get"; channelId: string }
  | { type: "repo.set"; channelId: string; repoInput: string }
  | { type: "model.set"; channelId: string; requestedModel: string }
  | { type: "skill.set-enabled"; channelId: string; requestedSkill: string; enabled: boolean }
  | { type: "thread.get-current"; channelId: string }
  | { type: "thread.rename"; channelId: string; name: string }
  | { type: "thread.read"; channelId: string; threadId?: string }
  | { type: "thread.archive"; channelId: string; threadId?: string }
  | { type: "thread.unarchive"; threadId: string }
  | { type: "thread.rollback"; channelId: string; numTurns: number; threadId?: string }
  | { type: "thread.compact"; channelId: string; threadId?: string }
  | { type: "turn.interrupt"; channelId: string };

export type ControlActionResult =
  | { type: "repo.get"; currentRepo: string | null }
  | { type: "repo.set"; repoSlug: string; activeThreadId: string | null }
  | { type: "model.set"; ok: true; threadId: string; model: string }
  | { type: "model.set"; ok: false; message: string }
  | { type: "skill.set-enabled"; ok: true; requestedSkill: string; enabled: boolean; effectiveEnabled: boolean }
  | { type: "skill.set-enabled"; ok: false; message: string }
  | { type: "thread.get-current"; threadId: string | null }
  | { type: "thread.rename"; ok: true; threadId: string; name: string }
  | { type: "thread.rename"; ok: false; message: string }
  | { type: "thread.read"; ok: true; threadId: string; thread: ReadThreadResponse["thread"] }
  | { type: "thread.read"; ok: false; message: string }
  | { type: "thread.archive"; ok: true; threadId: string; clearedActiveBinding: boolean }
  | { type: "thread.archive"; ok: false; message: string }
  | { type: "thread.unarchive"; ok: true; threadId: string }
  | { type: "thread.rollback"; ok: true; threadId: string; numTurns: number }
  | { type: "thread.rollback"; ok: false; message: string }
  | { type: "thread.compact"; ok: true; threadId: string }
  | { type: "thread.compact"; ok: false; message: string }
  | { type: "turn.interrupt"; ok: true; threadId: string }
  | { type: "turn.interrupt"; ok: false; message: string };

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
  if (request.type === "repo.get") {
    return {
      type: "repo.get",
      currentRepo: context.getChannelRepo(request.channelId),
    };
  }

  if (request.type === "repo.set") {
    const configured = await context.setChannelRepo(request.channelId, request.repoInput);
    return {
      type: "repo.set",
      repoSlug: configured.repoSlug,
      activeThreadId: context.getActiveThreadId(request.channelId),
    };
  }

  if (request.type === "model.set") {
    const threadId = context.getActiveThreadId(request.channelId);
    if (!threadId) {
      return {
        type: "model.set",
        ok: false,
        message: "No active thread in this channel yet. Use !newthread first.",
      };
    }

    const models = await context.conversation.listModels({ limit: 100, includeHidden: true });
    const resolved = resolveModelArgument(models.data, request.requestedModel);
    if (!resolved) {
      return {
        type: "model.set",
        ok: false,
        message: `Unknown model: \`${request.requestedModel}\`. Use \`!models\` to inspect available models.`,
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

  if (request.type === "thread.get-current") {
    return {
      type: "thread.get-current",
      threadId: context.getActiveThreadId(request.channelId),
    };
  }

  if (request.type === "thread.rename") {
    const threadId = context.getActiveThreadId(request.channelId);
    if (!threadId) {
      return {
        type: "thread.rename",
        ok: false,
        message: "No active thread in this channel.",
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
    const threadId = request.threadId ?? context.getActiveThreadId(request.channelId);
    if (!threadId) {
      return {
        type: "thread.read",
        ok: false,
        message: "Usage: !threadread <id>",
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

  if (request.type === "thread.archive") {
    const threadId = request.threadId ?? context.getActiveThreadId(request.channelId);
    if (!threadId) {
      return {
        type: "thread.archive",
        ok: false,
        message: "Usage: !archive <id>",
      };
    }
    await context.conversation.archiveThread(threadId);
    const clearedActiveBinding = context.getActiveThreadId(request.channelId) === threadId;
    if (clearedActiveBinding) {
      context.clearChannelThread?.(request.channelId);
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
    const threadId = request.threadId ?? context.getActiveThreadId(request.channelId);
    if (!Number.isInteger(request.numTurns) || request.numTurns < 1 || !threadId) {
      return {
        type: "thread.rollback",
        ok: false,
        message: "Usage: !rollback <numTurns> [id]",
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
    const threadId = request.threadId ?? context.getActiveThreadId(request.channelId);
    if (!threadId) {
      return {
        type: "thread.compact",
        ok: false,
        message: "Usage: !compact <id>",
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
    const threadId = context.getActiveThreadId(request.channelId);
    if (!threadId) {
      return {
        type: "turn.interrupt",
        ok: false,
        message: "No active thread in this channel.",
      };
    }
    await context.conversation.interruptTurn(threadId);
    return {
      type: "turn.interrupt",
      ok: true,
      threadId,
    };
  }

  const threadId = context.getActiveThreadId(request.channelId);
  if (!threadId) {
    return {
      type: "skill.set-enabled",
      ok: false,
      message: "No active thread in this channel. Use !newthread or !thread <id> first.",
    };
  }

  const listed = await context.conversation.listSkills(threadId, {});
  const resolved = resolveSkillPathFromList(listed, request.requestedSkill);
  if ("error" in resolved) {
    return {
      type: "skill.set-enabled",
      ok: false,
      message: resolved.error,
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
