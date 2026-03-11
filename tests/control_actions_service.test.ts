import { describe, expect, test } from "bun:test";

import { executeControlAction, type ControlActionsContext } from "../server/core/control_actions_service.js";

function makeContext(overrides?: {
  currentRepo?: string | null;
  activeThreadId?: string | null;
  listModels?: () => Promise<{
    data: Array<{
      id: string;
      model: string;
      displayName: string;
      description: string;
      hidden: boolean;
      isDefault: boolean;
      supportsPersonality: boolean;
    }>;
    nextCursor: null;
  }>;
  listSkills?: () => Promise<{
    data: Array<{
      cwd: string;
      errors: never[];
      skills: Array<{
        name: string;
        scope: "user" | "repo" | "system" | "admin";
        path: string;
        description: string;
        enabled: boolean;
      }>;
    }>;
  }>;
}) {
  const modelWrites: Array<{ threadId: string; model: string }> = [];
  const repoWrites: Array<{ channelId: string; repoSlug: string }> = [];
  const skillWrites: Array<{ threadId: string; path: string; enabled: boolean }> = [];

  const context: ControlActionsContext = {
    conversation: {
      async listSkills() {
        if (overrides?.listSkills) return overrides.listSkills();
        return {
          data: [
            {
              cwd: "/home/tadhiel/shepherd",
              errors: [],
              skills: [
                {
                  name: "github",
                  scope: "repo",
                  path: "/home/tadhiel/shepherd/.codex/skills/github/SKILL.md",
                  description: "",
                  enabled: true,
                },
              ],
            },
          ],
        };
      },
      async writeSkillConfig(threadId, request) {
        skillWrites.push({ threadId, path: request.path, enabled: request.enabled });
        return { effectiveEnabled: request.enabled };
      },
      async listModels() {
        if (overrides?.listModels) return overrides.listModels();
        return {
          data: [
            {
              id: "gpt-5.3-codex",
              model: "gpt-5.3-codex",
              displayName: "GPT-5.3 Codex",
              description: "",
              hidden: false,
              isDefault: true,
              supportsPersonality: true,
            },
          ],
          nextCursor: null,
        };
      },
      setThreadModel(threadId, model) {
        modelWrites.push({ threadId, model });
        return {
          threadId,
          currentModel: "o4-mini",
          modelProvider: "openai",
          pendingModel: model,
        };
      },
    },
    getActiveThreadId() {
      return overrides?.activeThreadId === undefined ? "thread-1" : overrides.activeThreadId;
    },
    getChannelRepo() {
      return overrides?.currentRepo ?? null;
    },
    async setChannelRepo(channelId, repoSlug) {
      repoWrites.push({ channelId, repoSlug });
      return { repoSlug };
    },
  };

  return { context, modelWrites, repoWrites, skillWrites };
}

describe("ControlActionsService", () => {
  test("reads the current repo binding", async () => {
    const { context } = makeContext({ currentRepo: "owner/repo" });
    await expect(
      executeControlAction(context, { type: "repo.get", channelId: "chan-1" }),
    ).resolves.toEqual({
      type: "repo.get",
      currentRepo: "owner/repo",
    });
  });

  test("sets the repo binding and returns active thread context", async () => {
    const { context, repoWrites } = makeContext({ activeThreadId: "thread-1" });
    await expect(
      executeControlAction(context, { type: "repo.set", channelId: "chan-1", repoInput: "owner/repo" }),
    ).resolves.toEqual({
      type: "repo.set",
      repoSlug: "owner/repo",
      activeThreadId: "thread-1",
    });
    expect(repoWrites).toEqual([{ channelId: "chan-1", repoSlug: "owner/repo" }]);
  });

  test("sets a pending thread model override", async () => {
    const { context, modelWrites } = makeContext();
    await expect(
      executeControlAction(context, {
        type: "model.set",
        channelId: "chan-1",
        requestedModel: "gpt-5.3-codex",
      }),
    ).resolves.toEqual({
      type: "model.set",
      ok: true,
      threadId: "thread-1",
      model: "gpt-5.3-codex",
    });
    expect(modelWrites).toEqual([{ threadId: "thread-1", model: "gpt-5.3-codex" }]);
  });

  test("returns the no-thread model error through the service", async () => {
    const { context } = makeContext({ activeThreadId: null });
    await expect(
      executeControlAction(context, {
        type: "model.set",
        channelId: "chan-1",
        requestedModel: "gpt-5.3-codex",
      }),
    ).resolves.toEqual({
      type: "model.set",
      ok: false,
      message: "No active thread in this channel yet. Use !newthread first.",
    });
  });

  test("enables or disables a skill using shared resolution semantics", async () => {
    const { context, skillWrites } = makeContext();
    await expect(
      executeControlAction(context, {
        type: "skill.set-enabled",
        channelId: "chan-1",
        requestedSkill: "github",
        enabled: false,
      }),
    ).resolves.toEqual({
      type: "skill.set-enabled",
      ok: true,
      requestedSkill: "github",
      enabled: false,
      effectiveEnabled: false,
    });
    expect(skillWrites).toEqual([
      {
        threadId: "thread-1",
        path: "/home/tadhiel/shepherd/.codex/skills/github/SKILL.md",
        enabled: false,
      },
    ]);
  });

  test("returns skill resolution failures through the service", async () => {
    const { context } = makeContext({
      async listSkills() {
        return {
          data: [
            {
              cwd: "/home/tadhiel/shepherd",
              errors: [],
              skills: [
                {
                  name: "github",
                  scope: "repo",
                  path: "/home/tadhiel/shepherd/.codex/skills/github/SKILL.md",
                  description: "",
                  enabled: true,
                },
                {
                  name: "github",
                  scope: "user",
                  path: "/home/tadhiel/.codex/skills/github/SKILL.md",
                  description: "",
                  enabled: true,
                },
              ],
            },
          ],
        };
      },
    });
    await expect(
      executeControlAction(context, {
        type: "skill.set-enabled",
        channelId: "chan-1",
        requestedSkill: "github",
        enabled: false,
      }),
    ).resolves.toEqual({
      type: "skill.set-enabled",
      ok: false,
      message: "Multiple skills match `github`: github [repo], github [user]. Use the full path.",
    });
  });
});
