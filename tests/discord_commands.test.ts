import { describe, expect, test } from "bun:test";
import { ComponentType, type MessageCreateOptions, type MessageEditOptions } from "discord.js";

import { handleMessage, type CommandContext } from "../server/adapters/discord/commands.js";

type RuntimeLifecycle = NonNullable<CommandContext["runtimeLifecycle"]>;

function makeMessage(content: string) {
  const replies: Array<string | MessageCreateOptions> = [];
  const edits: Array<string | MessageEditOptions> = [];
  return {
    message: {
      content,
      channelId: "chan-1",
      guildId: "guild-1",
      author: { id: "user-1" },
      channel: {
        async send(payload: string | MessageCreateOptions) {
          replies.push(payload);
          return { id: `reply-${replies.length}`, async edit() {} };
        },
      },
      id: "user-message-1",
      async reply(payload: string | MessageCreateOptions) {
        replies.push(payload);
        return {
          id: `reply-${replies.length}`,
          async edit(next: string | MessageEditOptions) {
            edits.push(next);
          },
        } as never;
      },
    },
    replies,
    edits,
  };
}

function componentJson(value: unknown): Record<string, unknown> {
  return (value && typeof value === "object" && "toJSON" in value
    ? (value as { toJSON: () => unknown }).toJSON()
    : value) as Record<string, unknown>;
}

function componentText(value: unknown): string[] {
  const component = componentJson(value);
  if (component.type === ComponentType.TextDisplay) return [String(component.content)];
  return ((component.components as unknown[] | undefined) ?? []).flatMap(componentText);
}

function replyTextAt(replies: Array<string | MessageCreateOptions>, index = 0): string {
  const reply = replies[index];
  if (typeof reply === "string") return reply;
  return (reply?.components ?? []).flatMap(componentText).join("\n");
}

function replyCardAt(replies: Array<string | MessageCreateOptions>, index = 0) {
  const texts = replyTextAt(replies, index).split("\n");
  const title = texts.shift()?.replace(/^##\s+/, "") ?? "";
  return { title, description: texts.join("\n") };
}

function editedCardAt(edits: Array<string | MessageEditOptions>, index = 0) {
  const edit = edits[index];
  if (typeof edit === "string") return { title: "", description: edit };
  const texts = (edit?.components ?? []).flatMap(componentText).join("\n").split("\n");
  return { title: texts.shift()?.replace(/^##\s+/, "") ?? "", description: texts.join("\n") };
}

function makeContext(overrides?: {
  listSkills?: () => Promise<unknown>;
  writeSkillConfig?: (threadId: string, request: { path: string; enabled: boolean }) => Promise<{ effectiveEnabled: boolean }>;
  listModels?: () => Promise<unknown>;
  getThreadModel?: () => { threadId: string; currentModel: string | null; modelProvider: string | null; pendingModel: string | null };
  setThreadModel?: (threadId: string, model: string) => { threadId: string; currentModel: string | null; modelProvider: string | null; pendingModel: string | null };
  getSurfaceProject?: () => string | null;
  setSurfaceProject?: (channelId: string, repoSlug: string) => Promise<{ repoSlug: string }>;
  readThread?: (threadId: string) => Promise<{ thread: { id: string; name?: string | null; preview?: string; updatedAt?: number | null } }>;
  readAccountRateLimits?: () => Promise<{ rateLimits: unknown }>;
  readThreadTokenUsage?: (threadId: string) => Promise<{ threadId: string; tokenUsage: unknown | null }>;
  getThreadState?: (threadId: string) => {
    threadId: string;
    sessionId: string | null;
    activeTurnId: string | null;
    approvalPolicy: "on-request";
  };
  restart?: RuntimeLifecycle["restart"];
  deploy?: RuntimeLifecycle["deploy"];
}) {
  const writes: Array<{ threadId: string; path: string; enabled: boolean }> = [];
  const modelWrites: Array<{ threadId: string; model: string }> = [];
  let restartRequests = 0;
  let listeningMode: "mention" | "open" | "paused" = "mention";
  let resumeMode: "mention" | "open" = "mention";
  let surfaceThreadId: string | null = "thread-1";
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
      async readAccountRateLimits() {
        if (overrides?.readAccountRateLimits) return overrides.readAccountRateLimits();
        return { rateLimits: { planType: "pro" } };
      },
      async readThreadTokenUsage(threadId: string) {
        if (overrides?.readThreadTokenUsage) return overrides.readThreadTokenUsage(threadId);
        return { threadId, tokenUsage: { total: { totalTokens: 42 }, last: {}, modelContextWindow: 128000 } };
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
      async listStoredThreads() {
        return {
          threads: [
            {
              threadId: "thread-1",
              name: "Embed work",
              preview: "Add structured Discord output",
              updatedAt: 123,
            },
          ],
          nextCursor: null,
        };
      },
      async listLoadedThreads() {
        return { threadIds: ["thread-1"] };
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
      getThreadState(threadId: string) {
        if (overrides?.getThreadState) return overrides.getThreadState(threadId);
        return {
          threadId,
          sessionId: "session-1",
          activeTurnId: null,
          approvalPolicy: "on-request",
        };
      },
    } as unknown as CommandContext["conversation"],
    getSurfaceThreadId() {
      return surfaceThreadId;
    },
    getSurfaceProject() {
      if (overrides?.getSurfaceProject) return overrides.getSurfaceProject();
      return null;
    },
    getSurfaceListeningMode() {
      return listeningMode;
    },
    setSurfaceListeningMode(_channelId, mode) {
      listeningMode = mode;
      resumeMode = mode;
      return mode;
    },
    pauseSurfaceListening() {
      if (listeningMode !== "paused") resumeMode = listeningMode;
      listeningMode = "paused";
      return listeningMode;
    },
    resumeSurfaceListening() {
      if (listeningMode === "paused") listeningMode = resumeMode;
      return listeningMode;
    },
    async setSurfaceProject(channelId: string, repoSlug: string) {
      if (overrides?.setSurfaceProject) return overrides.setSurfaceProject(channelId, repoSlug);
      return { repoSlug: "owner/repo" };
    },
    async ensureSurfaceThread() {
      return "thread-1";
    },
    async createSurfaceThread() {
      return "thread-1";
    },
    async forkSurfaceThread() {
      return "thread-2";
    },
    async switchSurfaceThread(_channelId: string, threadId: string) {
      return threadId;
    },
    clearSurfaceThread() {
      surfaceThreadId = null;
      listeningMode = "mention";
      resumeMode = "mention";
    },
    runtimeLifecycle: {
      async restart(options) {
        if (overrides?.restart) return overrides.restart(options);
        await options.announce({ action: "restart" });
        restartRequests += 1;
        return { type: "restart-requested", action: "restart" };
      },
      async deploy(options) {
        if (overrides?.deploy) return overrides.deploy(options);
        const deployment = {
          previousCommit: "1111111111111111111111111111111111111111",
          deployedCommit: "2222222222222222222222222222222222222222",
          changed: true,
        };
        await options.onDeploymentStarted?.();
        await options.announce({ action: "deploy", deployment });
        restartRequests += 1;
        return { type: "restart-requested", action: "deploy", deployment };
      },
    },
  };

  return {
    context,
    writes,
    modelWrites,
    getRestartRequests: () => restartRequests,
    getListeningMode: () => listeningMode,
    getSurfaceThreadId: () => surfaceThreadId,
  };
}

describe("Discord listening commands", () => {
  test("opens, pauses, and resumes channel input without interrupting the thread", async () => {
    const { context, getListeningMode } = makeContext();

    const opened = makeMessage("!listen open");
    await handleMessage(opened.message as never, context);
    expect(getListeningMode()).toBe("open");
    expect(replyCardAt(opened.replies)).toEqual({
      title: "Listening updated",
      description: "Listening is now **open**. Human text and images in this channel will be sent to the active thread.",
    });

    const paused = makeMessage("!pause");
    await handleMessage(paused.message as never, context);
    expect(getListeningMode()).toBe("paused");
    expect(replyCardAt(paused.replies).title).toBe("Listening paused");

    const resumed = makeMessage("!resume");
    await handleMessage(resumed.message as never, context);
    expect(getListeningMode()).toBe("open");
    expect(replyCardAt(resumed.replies)).toEqual({
      title: "Listening resumed",
      description: "Resumed in **Open** mode.",
    });
  });

  test("detaches without archiving and resets the channel to mention-only", async () => {
    const { context, getListeningMode, getSurfaceThreadId } = makeContext();
    context.setSurfaceListeningMode("chan-1", "open");
    const { message, replies } = makeMessage("!detach");

    await handleMessage(message as never, context);

    expect(getSurfaceThreadId()).toBeNull();
    expect(getListeningMode()).toBe("mention");
    expect(replyCardAt(replies)).toEqual({
      title: "Channel detached",
      description: "Channel detached from thread thread-1. The Codex thread was retained and can be reattached with `!thread thread-1`.",
    });
  });

  test("reports consolidated channel status", async () => {
    const { context } = makeContext({
      getSurfaceProject() {
        return "owner/repo";
      },
    });
    context.setSurfaceListeningMode("chan-1", "open");
    const { message, replies } = makeMessage("!status");

    await handleMessage(message as never, context);

    const embed = replyCardAt(replies);
    expect(embed.title).toBe("Shepherd channel");
    expect(embed.description).toContain("Listening: Open");
    expect(embed.description).toContain("Repository: owner/repo");
  });

  test("keeps direct messages open unless explicitly paused", async () => {
    const { context, getListeningMode } = makeContext();
    const direct = makeMessage("!listen mentions");
    direct.message.guildId = null as never;

    await handleMessage(direct.message as never, context);

    expect(getListeningMode()).toBe("mention");
    expect(replyCardAt(direct.replies)).toEqual({
      title: "Listening",
      description: "Direct messages are always open. Use `!pause` to stop conversation input.",
    });
  });
});

describe("Discord !skill commands", () => {
  test("renders help as a Markdown command card", async () => {
    const { message, replies } = makeMessage("!help");
    const { context } = makeContext();

    await handleMessage(message as never, context);

    const embed = replyCardAt(replies);
    expect(embed.title).toBe("Shepherd commands");
    expect(embed.description).toContain("- !rollback <numTurns> [id]");
  });

  test("renders context telemetry as a structured Components V2 card", async () => {
    const { message, replies } = makeMessage("!context");
    const { context } = makeContext();

    await handleMessage(message as never, context);

    const embed = replyCardAt(replies);
    expect(embed.title).toBe("Context usage");
    expect(embed.description).toContain("Context left");
    expect(embed.description).toContain("**Total Token Usage**");
  });

  test("renders skill and thread listings as Components V2 cards", async () => {
    const skills = makeMessage("!skills");
    const threads = makeMessage("!threads");
    const { context } = makeContext();

    await handleMessage(skills.message as never, context);
    await handleMessage(threads.message as never, context);

    expect(replyCardAt(skills.replies).title).toBe("Skills");
    expect(replyCardAt(skills.replies).description).toContain("github [workspace] enabled");
    expect(replyCardAt(threads.replies).title).toBe("Active threads");
    expect(replyCardAt(threads.replies).description).toContain("thread-1");
  });

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
    expect(replyCardAt(replies)).toEqual({
      title: "Skill disabled",
      description: "Disabled skill github (effectiveEnabled=false)",
    });
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
    expect(replyCardAt(replies)).toEqual({
      title: "Skill update failed",
      description: "Multiple skills match `github`: github [workspace], github [personal]. Use the full path.",
    });
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
    const embed = replyCardAt(replies);
    expect(embed.title).toBe("Models");
    expect(embed.description).toContain("`gpt-5.3-codex` [pending, default]");
    expect(embed.description).toContain("`o4-mini` [current]");
    expect(embed.description).toContain("Current: o4-mini");
  });

  test("stores a thread-scoped pending model override", async () => {
    const { message, replies } = makeMessage("!model set gpt-5.3-codex");
    const { context, modelWrites } = makeContext();

    await handleMessage(message as never, context);

    expect(modelWrites).toEqual([{ threadId: "thread-1", model: "gpt-5.3-codex" }]);
    expect(replyCardAt(replies)).toEqual({
      title: "Model updated",
      description: "Model for thread thread-1 set to `gpt-5.3-codex`.\nApplies to the next new turn and subsequent turns.",
    });
  });

  test("reports the current repo binding for the channel", async () => {
    const { message, replies } = makeMessage("!repo");
    const { context } = makeContext({
      getSurfaceProject() {
        return "owner/repo";
      },
    });

    await handleMessage(message as never, context);

    expect(replyCardAt(replies)).toEqual({
      title: "Repository",
      description: "Current repo for this channel: owner/repo",
    });
  });

  test("formats repo set replies using active thread context", async () => {
    const { message, replies } = makeMessage("!repo owner/repo");
    const { context } = makeContext({
      async setSurfaceProject(_channelId, repoSlug) {
        return { repoSlug };
      },
    });

    await handleMessage(message as never, context);

    expect(replyCardAt(replies)).toEqual({
      title: "Repository updated",
      description: "Repo set for this channel: owner/repo\nNote: active thread thread-1 keeps its current session/cwd; this repo applies to future !newthread/!fork.",
    });
  });

  test("formats current thread replies using the control action result", async () => {
    const { message, replies } = makeMessage("!thread");
    const { context } = makeContext();

    await handleMessage(message as never, context);

    expect(replyCardAt(replies)).toEqual({
      title: "Thread",
      description: "Current thread: thread-1",
    });
  });

  test("formats new thread replies through the orchestration action result", async () => {
    const { message, replies } = makeMessage("!newthread");
    const { context } = makeContext();

    await handleMessage(message as never, context);

    expect(replyCardAt(replies)).toEqual({
      title: "Thread created",
      description: "Started new thread: thread-1",
    });
  });

  test("switches thread ids through the orchestration context", async () => {
    const { message, replies } = makeMessage("!thread thread-9");
    const { context } = makeContext();

    await handleMessage(message as never, context);

    expect(replyCardAt(replies)).toEqual({
      title: "Thread switched",
      description: "Switched active thread to: thread-9",
    });
  });

  test("formats fork replies through the orchestration action result", async () => {
    const { message, replies } = makeMessage("!fork");
    const { context } = makeContext();

    await handleMessage(message as never, context);

    expect(replyCardAt(replies)).toEqual({
      title: "Thread forked",
      description: "Forked thread thread-1 -> thread-2",
    });
  });

  test("formats thread read replies from structured thread data", async () => {
    const { message, replies } = makeMessage("!threadread");
    const { context } = makeContext();

    await handleMessage(message as never, context);

    const embed = replyCardAt(replies);
    expect(embed.title).toBe("Thread");
    expect(embed.description).toContain("Preview: preview");
  });

  test("formats limits replies from the control action result", async () => {
    const { message, replies } = makeMessage("!limits");
    const { context } = makeContext();

    await handleMessage(message as never, context);

    expect(replies).toHaveLength(1);
    const embed = replyCardAt(replies);
    expect(embed.title).toBe("Rate limits");
    expect(embed.description).toContain("Plan: pro");
  });

  test("rejects unknown bang commands instead of treating them as conversation input", async () => {
    const { message, replies } = makeMessage("!doesnotexist");
    const { context } = makeContext();

    const result = await handleMessage(message as never, context);

    expect(result).toEqual({ handled: true, threadId: null, input: null });
    expect(replyCardAt(replies)).toEqual({
      title: "Unknown command",
      description: "Unknown command: `!doesnotexist`. Use `!help` to inspect available commands.",
    });
  });

  test("renders thread state changes as Components V2 cards", async () => {
    const { context } = makeContext({
      getThreadState(threadId) {
        return {
          threadId,
          sessionId: "session-1",
          activeTurnId: "turn-1",
          approvalPolicy: "on-request",
        };
      },
    });
    const cases = [
      ["!threadname Release prep", "Thread renamed"],
      ["!rollback 1 thread-1", "Thread rolled back"],
      ["!compact thread-1", "Compaction started"],
      ["!interrupt", "Interrupt requested"],
      ["!archive thread-1", "Thread archived"],
      ["!unarchive thread-1", "Thread unarchived"],
    ] as const;

    for (const [command, title] of cases) {
      const { message, replies } = makeMessage(command);
      await handleMessage(message as never, context);
      expect(replyCardAt(replies).title).toBe(title);
    }
  });
});

describe("Discord operational commands", () => {
  test("posts recovery commands before requesting a restart", async () => {
    const { message, replies } = makeMessage("!restart");
    const { context, getRestartRequests } = makeContext({
      getSurfaceProject() {
        return "owner/repo";
      },
    });

    await handleMessage(message as never, context);

    expect(replyCardAt(replies).title).toBe("Restarting Shepherd");
    expect(replyCardAt(replies).description).toContain("!repo owner/repo");
    expect(getRestartRequests()).toBe(1);
  });

  test("includes open listening mode in restart recovery commands", async () => {
    const { message, replies } = makeMessage("!restart");
    const { context } = makeContext({
      getSurfaceProject() {
        return "owner/repo";
      },
    });
    context.setSurfaceListeningMode("chan-1", "open");

    await handleMessage(message as never, context);

    expect(replyCardAt(replies).description).toContain("!listen open");
  });

  test("refuses restart while a turn is active", async () => {
    const { message, replies } = makeMessage("!restart");
    const { context, getRestartRequests } = makeContext({
      async restart() {
        return {
          type: "busy",
          action: "restart",
          stage: "before-operation",
          activity: { activeTurnThreadIds: ["thread-busy"], pendingApprovalIds: [] },
        };
      },
    });

    await handleMessage(message as never, context);

    expect(replyCardAt(replies).title).toBe("Restart refused");
    expect(replyCardAt(replies).description).toContain("Active turns: thread-busy");
    expect(getRestartRequests()).toBe(0);
  });

  test("validates a deployment before posting recovery commands and restarting", async () => {
    const { message, replies, edits } = makeMessage("!deploy");
    const { context, getRestartRequests } = makeContext({
      getSurfaceProject() {
        return "~/shepherd";
      },
    });

    await handleMessage(message as never, context);

    expect(replies).toHaveLength(1);
    expect(replyCardAt(replies).title).toBe("Checking deployment");
    expect(edits).toHaveLength(1);
    expect(editedCardAt(edits).title).toBe("Deployment validated");
    expect(editedCardAt(edits).description).toContain("1111111 → 2222222");
    expect(getRestartRequests()).toBe(1);
  });

  test("keeps Shepherd online when deployment validation fails", async () => {
    const { message, replies, edits } = makeMessage("!deploy");
    const { context, getRestartRequests } = makeContext({
      async deploy(options) {
        await options.onDeploymentStarted?.();
        return {
          type: "deployment-failed",
          message: "tests failed; restored previous commit",
        };
      },
    });

    await handleMessage(message as never, context);

    expect(replies).toHaveLength(1);
    expect(replyCardAt(replies).title).toBe("Checking deployment");
    expect(edits).toHaveLength(1);
    expect(editedCardAt(edits).title).toBe("Deployment failed");
    expect(editedCardAt(edits).description).toContain("tests failed; restored previous commit");
    expect(getRestartRequests()).toBe(0);
  });
});
