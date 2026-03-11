import { describe, expect, test } from "bun:test";

import { executeControlAction, type ControlActionsContext } from "../server/core/control_actions_service.js";

function makeContext(overrides?: {
  currentRepo?: string | null;
  activeThreadId?: string | null;
  readThread?: (threadId: string) => Promise<{ thread: { id: string; name?: string | null; preview?: string; updatedAt?: number | null } }>;
  readAccountRateLimits?: () => Promise<{ rateLimits: unknown }>;
  listRemoteSkills?: () => Promise<{ data: Array<{ id: string; name: string; description: string }> }>;
  exportRemoteSkill?: () => Promise<{ id: string; path: string }>;
  readThreadTokenUsage?: (threadId: string) => Promise<{ threadId: string; tokenUsage: unknown | null }>;
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
  const threadNameWrites: Array<{ threadId: string; name: string }> = [];
  const archivedThreads: string[] = [];
  const unarchivedThreads: string[] = [];
  const rolledBackThreads: Array<{ threadId: string; numTurns: number }> = [];
  const compactedThreads: string[] = [];
  const interruptedThreads: string[] = [];
  const clearedChannels: string[] = [];

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
      async readAccountRateLimits() {
        if (overrides?.readAccountRateLimits) return overrides.readAccountRateLimits();
        return { rateLimits: { planType: "pro" } };
      },
      async listRemoteSkills() {
        if (overrides?.listRemoteSkills) return overrides.listRemoteSkills();
        return { data: [{ id: "hz-1", name: "Remote", description: "desc" }] };
      },
      async exportRemoteSkill() {
        if (overrides?.exportRemoteSkill) return overrides.exportRemoteSkill();
        return { id: "hz-1", path: "/tmp/remote-skill" };
      },
      async readThreadTokenUsage(threadId: string) {
        if (overrides?.readThreadTokenUsage) return overrides.readThreadTokenUsage(threadId);
        return { threadId, tokenUsage: { total: { totalTokens: 42 } } };
      },
      getThreadModel(threadId: string) {
        return {
          threadId,
          currentModel: "o4-mini",
          modelProvider: "openai",
          pendingModel: null,
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
      async setThreadName(threadId, request) {
        threadNameWrites.push({ threadId, name: request.name });
        return { ok: true };
      },
      async readThread(threadId) {
        if (overrides?.readThread) return overrides.readThread(threadId);
        return { thread: { id: threadId, name: "demo", preview: "preview", updatedAt: 123 } };
      },
      async archiveThread(threadId) {
        archivedThreads.push(threadId);
        return { ok: true };
      },
      async unarchiveThread(threadId) {
        unarchivedThreads.push(threadId);
        return { ok: true };
      },
      async rollbackThread(threadId, request) {
        rolledBackThreads.push({ threadId, numTurns: request.numTurns });
        return { thread: { id: threadId } };
      },
      async compactThread(threadId) {
        compactedThreads.push(threadId);
        return { ok: true };
      },
      async interruptTurn(threadId) {
        interruptedThreads.push(threadId);
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
    clearChannelThread(channelId) {
      clearedChannels.push(channelId);
    },
  };

  return {
    context,
    modelWrites,
    repoWrites,
    skillWrites,
    threadNameWrites,
    archivedThreads,
    unarchivedThreads,
    rolledBackThreads,
    compactedThreads,
    interruptedThreads,
    clearedChannels,
  };
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

  test("returns the current active thread", async () => {
    const { context } = makeContext({ activeThreadId: "thread-1" });
    await expect(
      executeControlAction(context, { type: "thread.get-current", channelId: "chan-1" }),
    ).resolves.toEqual({
      type: "thread.get-current",
      threadId: "thread-1",
    });
  });

  test("renames the active thread", async () => {
    const { context, threadNameWrites } = makeContext();
    await expect(
      executeControlAction(context, { type: "thread.rename", channelId: "chan-1", name: "new-name" }),
    ).resolves.toEqual({
      type: "thread.rename",
      ok: true,
      threadId: "thread-1",
      name: "new-name",
    });
    expect(threadNameWrites).toEqual([{ threadId: "thread-1", name: "new-name" }]);
  });

  test("reads thread details using the active thread by default", async () => {
    const { context } = makeContext();
    await expect(
      executeControlAction(context, { type: "thread.read", channelId: "chan-1" }),
    ).resolves.toEqual({
      type: "thread.read",
      ok: true,
      threadId: "thread-1",
      thread: { id: "thread-1", name: "demo", preview: "preview", updatedAt: 123 },
    });
  });

  test("archives the active thread and clears the active binding", async () => {
    const { context, archivedThreads, clearedChannels } = makeContext();
    await expect(
      executeControlAction(context, { type: "thread.archive", channelId: "chan-1" }),
    ).resolves.toEqual({
      type: "thread.archive",
      ok: true,
      threadId: "thread-1",
      clearedActiveBinding: true,
    });
    expect(archivedThreads).toEqual(["thread-1"]);
    expect(clearedChannels).toEqual(["chan-1"]);
  });

  test("unarchives the requested thread", async () => {
    const { context, unarchivedThreads } = makeContext();
    await expect(
      executeControlAction(context, { type: "thread.unarchive", threadId: "thread-2" }),
    ).resolves.toEqual({
      type: "thread.unarchive",
      ok: true,
      threadId: "thread-2",
    });
    expect(unarchivedThreads).toEqual(["thread-2"]);
  });

  test("rolls back the requested thread", async () => {
    const { context, rolledBackThreads } = makeContext();
    await expect(
      executeControlAction(context, {
        type: "thread.rollback",
        channelId: "chan-1",
        numTurns: 2,
      }),
    ).resolves.toEqual({
      type: "thread.rollback",
      ok: true,
      threadId: "thread-1",
      numTurns: 2,
    });
    expect(rolledBackThreads).toEqual([{ threadId: "thread-1", numTurns: 2 }]);
  });

  test("starts compaction for the active thread", async () => {
    const { context, compactedThreads } = makeContext();
    await expect(
      executeControlAction(context, { type: "thread.compact", channelId: "chan-1" }),
    ).resolves.toEqual({
      type: "thread.compact",
      ok: true,
      threadId: "thread-1",
    });
    expect(compactedThreads).toEqual(["thread-1"]);
  });

  test("interrupts the active thread", async () => {
    const { context, interruptedThreads } = makeContext();
    await expect(
      executeControlAction(context, { type: "turn.interrupt", channelId: "chan-1" }),
    ).resolves.toEqual({
      type: "turn.interrupt",
      ok: true,
      threadId: "thread-1",
    });
    expect(interruptedThreads).toEqual(["thread-1"]);
  });

  test("reads account limits through the service", async () => {
    const { context } = makeContext();
    await expect(executeControlAction(context, { type: "limits.read" })).resolves.toEqual({
      type: "limits.read",
      rateLimits: { planType: "pro" },
    });
  });

  test("lists models with current thread model state", async () => {
    const { context } = makeContext();
    const result = await executeControlAction(context, { type: "models.list", channelId: "chan-1" });
    expect(result.type).toBe("models.list");
    if (result.type !== "models.list") {
      throw new Error("Expected models.list result");
    }
    expect(result.modelState?.threadId).toBe("thread-1");
    expect(result.models.data[0]?.model).toBe("gpt-5.3-codex");
  });

  test("reads thread context telemetry", async () => {
    const { context } = makeContext();
    await expect(
      executeControlAction(context, { type: "context.read", channelId: "chan-1" }),
    ).resolves.toEqual({
      type: "context.read",
      ok: true,
      threadId: "thread-1",
      tokenUsage: { total: { totalTokens: 42 } },
    });
  });

  test("lists remote skills", async () => {
    const { context } = makeContext();
    await expect(
      executeControlAction(context, { type: "skills.list-remote", channelId: "chan-1" }),
    ).resolves.toEqual({
      type: "skills.list-remote",
      ok: true,
      remote: { data: [{ id: "hz-1", name: "Remote", description: "desc" }] },
    });
  });

  test("exports a remote skill", async () => {
    const { context } = makeContext();
    await expect(
      executeControlAction(context, {
        type: "skill.export-remote",
        channelId: "chan-1",
        hazelnutId: "hz-1",
      }),
    ).resolves.toEqual({
      type: "skill.export-remote",
      ok: true,
      exported: { id: "hz-1", path: "/tmp/remote-skill" },
    });
  });
});
