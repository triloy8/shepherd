import { describe, expect, test } from "bun:test";

import { handleMessage, type CommandContext } from "../server/adapters/discord/commands.js";

function makeMessage(content: string) {
  const replies: string[] = [];
  return {
    message: {
      content,
      channelId: "chan-1",
      async reply(text: string) {
        replies.push(text);
        return {} as never;
      },
    },
    replies,
  };
}

function makeContext(overrides?: {
  listSkills?: () => Promise<unknown>;
  writeSkillConfig?: (threadId: string, request: { path: string; enabled: boolean }) => Promise<{ effectiveEnabled: boolean }>;
  listModels?: () => Promise<unknown>;
  getThreadModel?: () => { threadId: string; currentModel: string | null; modelProvider: string | null; pendingModel: string | null };
  setThreadModel?: (threadId: string, model: string) => { threadId: string; currentModel: string | null; modelProvider: string | null; pendingModel: string | null };
  getChannelRepo?: () => string | null;
  setChannelRepo?: (channelId: string, repoSlug: string) => Promise<{ repoSlug: string }>;
  readThread?: (threadId: string) => Promise<{ thread: { id: string; name?: string | null; preview?: string; updatedAt?: number | null } }>;
}) {
  const writes: Array<{ threadId: string; path: string; enabled: boolean }> = [];
  const modelWrites: Array<{ threadId: string; model: string }> = [];
  const context: CommandContext = {
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
                  scope: "workspace",
                  path: "/home/tadhiel/shepherd/.codex/skills/github/SKILL.md",
                  description: "GitHub task execution with a gh-first workflow.",
                  enabled: true,
                },
              ],
            },
          ],
        };
      },
      async writeSkillConfig(threadId: string, request: { path: string; enabled: boolean }) {
        writes.push({ threadId, path: request.path, enabled: request.enabled });
        if (overrides?.writeSkillConfig) return overrides.writeSkillConfig(threadId, request);
        return { effectiveEnabled: !request.enabled ? false : true };
      },
      async listModels() {
        if (overrides?.listModels) return overrides.listModels();
        return {
          data: [
            {
              id: "gpt-5.3-codex",
              model: "gpt-5.3-codex",
              displayName: "GPT-5.3 Codex",
              description: "Default coding model",
              hidden: false,
              isDefault: true,
              supportsPersonality: true,
            },
            {
              id: "o4-mini",
              model: "o4-mini",
              displayName: "o4-mini",
              description: "Fast fallback",
              hidden: false,
              isDefault: false,
              supportsPersonality: true,
            },
          ],
          nextCursor: null,
        };
      },
      getThreadModel() {
        if (overrides?.getThreadModel) return overrides.getThreadModel();
        return {
          threadId: "thread-1",
          currentModel: "o4-mini",
          modelProvider: "openai",
          pendingModel: null,
        };
      },
      setThreadModel(threadId: string, model: string) {
        modelWrites.push({ threadId, model });
        if (overrides?.setThreadModel) return overrides.setThreadModel(threadId, model);
        return {
          threadId,
          currentModel: "o4-mini",
          modelProvider: "openai",
          pendingModel: model,
        };
      },
      async setThreadName() {
        return { ok: true };
      },
      async readThread(threadId: string) {
        if (overrides?.readThread) return overrides.readThread(threadId);
        return {
          thread: { id: threadId, name: "demo", preview: "preview", updatedAt: 123 },
        };
      },
      async archiveThread() {
        return { ok: true };
      },
      async unarchiveThread() {
        return { ok: true };
      },
      async rollbackThread(threadId: string) {
        return { thread: { id: threadId } };
      },
      async compactThread() {
        return { ok: true };
      },
      async interruptTurn() {},
    } as unknown as CommandContext["conversation"],
    getActiveThreadId() {
      return "thread-1";
    },
    getChannelRepo() {
      if (overrides?.getChannelRepo) return overrides.getChannelRepo();
      return null;
    },
    async setChannelRepo(channelId: string, repoSlug: string) {
      if (overrides?.setChannelRepo) return overrides.setChannelRepo(channelId, repoSlug);
      return { repoSlug: "owner/repo" };
    },
    async ensureChannelThread() {
      return "thread-1";
    },
    async createAndBindChannelThread() {
      return "thread-1";
    },
    async resumeChannelThread() {
      return "thread-1";
    },
    async forkChannelThread() {
      return "thread-2";
    },
    async bindChannelToThread() {},
    clearChannelThread() {},
  };

  return { context, writes, modelWrites };
}

describe("Discord !skill commands", () => {
  test("resolves a displayed skill name to its underlying path", async () => {
    const { message, replies } = makeMessage("!skill disable github");
    const { context, writes } = makeContext();

    await handleMessage(message as never, context);

    expect(writes).toEqual([
      {
        threadId: "thread-1",
        path: "/home/tadhiel/shepherd/.codex/skills/github/SKILL.md",
        enabled: false,
      },
    ]);
    expect(replies).toEqual(["Disabled skill github (effectiveEnabled=false)"]);
  });

  test("returns a clear error when the displayed name is ambiguous", async () => {
    const { message, replies } = makeMessage("!skill disable github");
    const { context, writes } = makeContext({
      async listSkills() {
        return {
          data: [
            {
              cwd: "/home/tadhiel/shepherd",
              errors: [],
              skills: [
                {
                  name: "github",
                  scope: "workspace",
                  path: "/home/tadhiel/shepherd/.codex/skills/github/SKILL.md",
                  description: "",
                  enabled: true,
                },
                {
                  name: "github",
                  scope: "personal",
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

    await handleMessage(message as never, context);

    expect(writes).toHaveLength(0);
    expect(replies).toEqual([
      "Multiple skills match `github`: github [workspace], github [personal]. Use the full path.",
    ]);
  });

  test("lists models and marks current/default state", async () => {
    const { message, replies } = makeMessage("!models");
    const { context } = makeContext({
      getThreadModel() {
        return {
          threadId: "thread-1",
          currentModel: "o4-mini",
          modelProvider: "openai",
          pendingModel: "gpt-5.3-codex",
        };
      },
    });

    await handleMessage(message as never, context);

    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("**Models**");
    expect(replies[0]).toContain("Current: o4-mini");
    expect(replies[0]).toContain("Pending next turn: gpt-5.3-codex");
    expect(replies[0]).toContain("`gpt-5.3-codex` [pending, default]");
    expect(replies[0]).toContain("`o4-mini` [current]");
  });

  test("stores a thread-scoped pending model override", async () => {
    const { message, replies } = makeMessage("!model set gpt-5.3-codex");
    const { context, modelWrites } = makeContext();

    await handleMessage(message as never, context);

    expect(modelWrites).toEqual([{ threadId: "thread-1", model: "gpt-5.3-codex" }]);
    expect(replies).toEqual([
      "Model for thread thread-1 set to `gpt-5.3-codex`.\nApplies to the next new turn and subsequent turns.",
    ]);
  });

  test("reports the current repo binding for the channel", async () => {
    const { message, replies } = makeMessage("!repo");
    const { context } = makeContext({
      getChannelRepo() {
        return "owner/repo";
      },
    });

    await handleMessage(message as never, context);

    expect(replies).toEqual(["Current repo for this channel: owner/repo"]);
  });

  test("formats repo set replies using active thread context", async () => {
    const { message, replies } = makeMessage("!repo owner/repo");
    const { context } = makeContext({
      async setChannelRepo(_channelId, repoSlug) {
        return { repoSlug };
      },
    });

    await handleMessage(message as never, context);

    expect(replies).toEqual([
      "Repo set for this channel: owner/repo\nNote: active thread thread-1 keeps its current session/cwd; this repo applies to future !newthread/!fork.",
    ]);
  });

  test("formats current thread replies using the control action result", async () => {
    const { message, replies } = makeMessage("!thread");
    const { context } = makeContext();

    await handleMessage(message as never, context);

    expect(replies).toEqual(["Current thread: thread-1"]);
  });

  test("formats thread read replies from structured thread data", async () => {
    const { message, replies } = makeMessage("!threadread");
    const { context } = makeContext();

    await handleMessage(message as never, context);

    expect(replies).toEqual([
      "Thread: thread-1\nName: demo\nUpdated: 1970-01-01T00:02:03.000Z\nPreview: preview",
    ]);
  });

  test("rejects unknown bang commands instead of treating them as conversation input", async () => {
    const { message, replies } = makeMessage("!doesnotexist");
    const { context } = makeContext();

    const result = await handleMessage(message as never, context);

    expect(result).toEqual({ handled: true, threadId: null, input: null });
    expect(replies).toEqual([
      "Unknown command: `!doesnotexist`. Use `!help` to inspect available commands.",
    ]);
  });
});
