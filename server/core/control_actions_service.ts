import type {
  ListModelsResponse,
  ModelSummary,
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
};

export type ControlActionsContext = {
  conversation: ControlConversation;
  getActiveThreadId: (channelId: string) => string | null;
  getChannelRepo: (channelId: string) => string | null;
  setChannelRepo: (channelId: string, repoSlug: string) => Promise<{ repoSlug: string }>;
};

export type ControlActionRequest =
  | { type: "repo.get"; channelId: string }
  | { type: "repo.set"; channelId: string; repoInput: string }
  | { type: "model.set"; channelId: string; requestedModel: string }
  | { type: "skill.set-enabled"; channelId: string; requestedSkill: string; enabled: boolean };

export type ControlActionResult =
  | { type: "repo.get"; currentRepo: string | null }
  | { type: "repo.set"; repoSlug: string; activeThreadId: string | null }
  | { type: "model.set"; ok: true; threadId: string; model: string }
  | { type: "model.set"; ok: false; message: string }
  | { type: "skill.set-enabled"; ok: true; requestedSkill: string; enabled: boolean; effectiveEnabled: boolean }
  | { type: "skill.set-enabled"; ok: false; message: string };

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
