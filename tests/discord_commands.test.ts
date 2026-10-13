import { account } from "./helpers/account";
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
  writeSkillConfig?: (threadId: string, request: { path: string; enabled: boolean }) => Promise<{ enabled: boolean }>;
  listModels?: () => Promise<unknown>;
  getThreadModel?: () => { threadId: string; currentModel: string | null; provider: string; pendingModel: string | null };
  setThreadModel?: (threadId: string, model: string) => { threadId: string; currentModel: string | null; provider: string; pendingModel: string | null };
  getSurfaceProject?: () => string | null;
  setSurfaceProject?: (channelId: string, repoSlug: string) => Promise<{ repoSlug: string }>;
  readThread?: (threadId: string) => Promise<{ thread: { id: string; name?: string | null; preview?: string; updatedAt?: number | null } }>;
  readAccountRateLimits?: () => Promise<{ rateLimits: unknown }>;
  readThreadTokenUsage?: (threadId: string) => Promise<{ threadId: string; tokenUsage: unknown | null }>;
  getThreadState?: (threadId: string) => {
    threadId: string;
    sessionId: string | null;
    activeTurnId: string | null;
    approvalPolicy: "review_sensitive";
  };
  restart?: RuntimeLifecycle["restart"];
  deploy?: RuntimeLifecycle["deploy"];
  deploymentStatus?: RuntimeLifecycle["deploymentStatus"];
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
          workspacePath: "/home/tadhiel/shepherd",
          errors: [],
          skills: [
            {
              name: "github",
              scope: "workspace",
              path: "/home/tadhiel/shepherd/.agents/skills/github/SKILL.md",
              description: "GitHub task execution with a gh-first workflow.",
              enabled: true,
            },
          ],
        };
      },
      async writeSkillConfig(threadId: string, request: { path: string; enabled: boolean }) {
        writes.push({ threadId, path: request.path, enabled: request.enabled });
        if (overrides?.writeSkillConfig) return overrides.writeSkillConfig(threadId, request);
        return { enabled: !request.enabled ? false : true };
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
            },
            {
              id: "o4-mini",
              model: "o4-mini",
              displayName: "o4-mini",
              description: "Fast fallback",
              hidden: false,
              isDefault: false,
            },
          ],
          nextCursor: null,
        };
      },
      getThreadProvider: () => "fixture",
      listProviders: () => [{ id: "fixture", displayName: "Fixture", isDefault: true, capabilities: { steer: true, interrupt: true, rename: true, archive: true, unarchive: true, workspaceChange: true, modelCatalog: true, modelCatalogAuthoritative: true, modelSelection: true, effortSelection: true, skillConfig: true, questions: true, skills: true, compact: true, revert: true, fork: true, sandboxModes: [], approvalModes: ["provider_default", "review_sensitive", "bypass"], inputKinds: ["text", "image", "image_file"], imageDetail: false, ephemeralThreads: false, accountReset: false } }],
      async readAccount() { return account("fixture", "pro"); },
      async resetAccount() { throw new Error("Unsupported account reset"); },
      async readThreadTokenUsage(threadId: string) {
        if (overrides?.readThreadTokenUsage) return overrides.readThreadTokenUsage(threadId);
        return { threadId, tokenUsage: { total: { totalTokens: 42 }, last: {}, contextWindow: 128000 } };
      },
      getThreadModel() {
        if (overrides?.getThreadModel) return overrides.getThreadModel();
        return {
          threadId: "thread-1",
          currentModel: "o4-mini",
          provider: "fixture",
          pendingModel: null,
        };
      },
      setThreadModel(threadId: string, model: string) {
        modelWrites.push({ threadId, model });
        if (overrides?.setThreadModel) return overrides.setThreadModel(threadId, model);
        return {
          threadId,
          currentModel: "o4-mini",
          provider: "fixture",
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
      async revertThread(threadId: string) {
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
          approvalPolicy: "review_sensitive",
          capabilities: context.conversation.listProviders()[0]!.capabilities,
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
      runningCommit: async () => null,
      async restart(options) {
        if (overrides?.restart) return overrides.restart(options);
        await options.announce({ action: "restart" });
        restartRequests += 1;
        return { type: "restart-requested", action: "restart" };
      },
      async deploy(options) {
        if (overrides?.deploy) return overrides.deploy(options);
        const target = options.target ?? { kind: "main" as const };
        const deployment = {
          previousCommit: "1111111111111111111111111111111111111111",
          deployedCommit: "2222222222222222222222222222222222222222",
          changed: true,
          target,
        };
        await options.onDeploymentStarted?.();
        await options.announce({ action: "deploy", deployment });
        restartRequests += 1;
        return { type: "restart-requested", action: "deploy", deployment };
      },
      async deploymentStatus() {
        if (overrides?.deploymentStatus) return overrides.deploymentStatus();
        return {
          deployedCommit: "2222222222222222222222222222222222222222",
          matchingRemoteRefs: ["origin/main"],
          deploymentInProgress: false,
        };
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
      description: "Channel detached from thread thread-1. The agent thread was retained and can be reattached with `!thread thread-1`.",
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
    expect(embed.description).not.toContain("!rollback");
  });

  test("help hides commands the conversation's agent does not support", async () => {
    const { message, replies } = makeMessage("!help");
    const { context } = makeContext();
    const capabilities = { ...context.conversation.listProviders()[0]!.capabilities, compact: false, skills: false, skillConfig: false, effortSelection: false };
    Object.assign(context.conversation, { getThreadState: (threadId: string) => ({ threadId, sessionId: "s", activeTurnId: null, approvalPolicy: "review_sensitive", capabilities }) });

    await handleMessage(message as never, context);

    const description = replyCardAt(replies).description;
    expect(description).toContain("this conversation's agent does not support are hidden");
    for (const hidden of ["!compact", "!skills", "!skill enable", "set <level|default>"]) expect(description).not.toContain(hidden);
    for (const shown of ["!fork", "!model set", "- !effort"]) expect(description).toContain(shown);
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

  test("distinguishes token counts the provider does not report from unknown values", async () => {
    const { message, replies } = makeMessage("!context");
    const breakdown = { inputTokens: 10, cacheReadInputTokens: 4, cacheWriteInputTokens: null, outputTokens: 5, reasoningOutputTokens: null, totalTokens: 15 };
    const { context } = makeContext({ readThreadTokenUsage: async (threadId) => ({ threadId, tokenUsage: { last: breakdown, total: breakdown, contextWindow: 100 } }) });

    await handleMessage(message as never, context);

    const description = replyCardAt(replies).description;
    expect(description).toContain("- Cache read: 4");
    expect(description).toContain("- Cache write: not reported");
    expect(description).toContain("- Reasoning output: not reported");
    expect(description).toContain("- Context left: 85%");
  });

  test("renders skill and thread listings as Components V2 cards", async () => {
    const skills = makeMessage("!skills");
    const threads = makeMessage("!threads");
    const { context } = makeContext();

    await handleMessage(skills.message as never, context);
    await handleMessage(threads.message as never, context);

    expect(replyCardAt(skills.replies).title).toBe("Skills");
    expect(replyCardAt(skills.replies).description).toContain("1. github**\n[workspace] enabled");
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
        path: "/home/tadhiel/shepherd/.agents/skills/github/SKILL.md",
        enabled: false,
      },
    ]);
    expect(replyCardAt(replies)).toEqual({
      title: "Skill disabled",
      description: "Disabled skill github (now disabled)",
    });
  });

  test("returns a clear error when the displayed name is ambiguous", async () => {
    const { message, replies } = makeMessage("!skill disable github");
    const { context, writes } = makeContext({
      async listSkills() {
        return {
          workspacePath: "/home/tadhiel/shepherd",
          errors: [],
          skills: [
            {
              name: "github",
              scope: "workspace",
              path: "/home/tadhiel/shepherd/.agents/skills/github/SKILL.md",
              description: "",
              enabled: true,
            },
            {
              name: "github",
              scope: "personal",
              path: "/home/tadhiel/.agents/skills/github/SKILL.md",
              description: "",
              enabled: true,
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
          provider: "fixture",
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

  test("!effort set preserves literal values regardless of the advertised model default", async () => {
    for (const [offered, requested, expected] of [[["low", "high"], "default", "default"], [["default", "high"], "default", "default"], [["DEFAULT", "high"], "DEFAULT", "DEFAULT"]] as const) {
      const { message } = makeMessage(`!effort set ${requested}`);
      const { context } = makeContext();
      const requests: Array<string | null> = [];
      const state = { threadId: "thread-1", model: "o4-mini", currentEffort: "low", pendingEffort: null, inputModalities: null, defaultEffort: "high", supportedEfforts: offered.map((value) => ({ value, description: value })) };
      Object.assign(context.conversation, {
        async getThreadEffort() { return state; },
        async setThreadEffort(_threadId: string, effort: string | null) { requests.push(effort); return { ...state, pendingEffort: effort ?? state.defaultEffort }; },
      });
      await handleMessage(message as never, context);
      expect(requests).toEqual([expected]);
    }
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

  test("effort commands preserve literal provider values and distinguish default and clear", async () => {
    const { context } = makeContext();
    const selections: unknown[] = [];
    Object.assign(context.conversation, {
      async setThreadEffort(threadId: string, effort: unknown) {
        selections.push(effort);
        return { threadId, model: "opaque-model", currentEffort: null,
          pendingEffort: typeof effort === "string" ? effort : null, pendingEffortClear: effort === null,
          inputModalities: ["text"], defaultEffort: "Focused", supportedEfforts: [{ value: "default", description: "" }, { value: "Focused", description: "" }] };
      },
    });
    for (const command of ["!effort set default", "!effort set Focused", "!effort default", "!effort clear"]) {
      const { message, replies } = makeMessage(command);
      await handleMessage(message as never, context);
      expect(replyCardAt(replies).title).toBe("Effort updated");
      if (command.endsWith("clear")) expect(replyCardAt(replies).description).toContain("clear effort override");
    }
    expect(selections).toEqual(["default", "Focused", { mode: "default" }, null]);
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

  test("retired rollback never invokes history mutation or forwards agent input", async () => {
    const { context } = makeContext();
    let mutations = 0;
    context.conversation.revertThread = async () => { mutations++; throw new Error("Must not invoke revert from Discord"); };
    for (const command of ["!rollback", "!rollback 2 thread-1", "!rollback invalid"]) {
      const { message, replies } = makeMessage(command);
      expect(await handleMessage(message as never, context)).toEqual({ handled: true, threadId: null, input: null });
      const card = replyCardAt(replies);
      expect(card.title).toBe("Rollback retired");
      expect(card.description).toContain("web UI");
      expect(card.description).toContain("Revert from here");
    }
    expect(mutations).toBe(0);
  });

  test("renders thread state changes as Components V2 cards", async () => {
    const { context } = makeContext({
      getThreadState(threadId) {
        return {
          threadId,
          sessionId: "session-1",
          activeTurnId: "turn-1",
          approvalPolicy: "review_sensitive",
        };
      },
    });
    const cases = [
      ["!threadname Release prep", "Thread renamed"],
      ["!rollback 1 thread-1", "Rollback retired"],
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
    expect(editedCardAt(edits).description).toContain("origin/main");
    expect(getRestartRequests()).toBe(1);
  });

  test("deploys a preview branch and explains how to return to main", async () => {
    const { message, replies, edits } = makeMessage("!deploy branch feat/user-test");
    let requestedTarget: unknown;
    const { context, getRestartRequests } = makeContext({
      async deploy(options) {
        requestedTarget = options.target;
        const deployment = {
          previousCommit: "1111111111111111111111111111111111111111",
          deployedCommit: "2222222222222222222222222222222222222222",
          changed: true,
          target: options.target ?? { kind: "main" as const },
        };
        await options.onDeploymentStarted?.();
        await options.announce({ action: "deploy", deployment });
        return { type: "restart-requested", action: "deploy", deployment };
      },
    });

    await handleMessage(message as never, context);

    expect(requestedTarget).toEqual({ kind: "branch", branch: "feat/user-test" });
    expect(replyCardAt(replies).description).toContain("origin/feat/user-test");
    expect(editedCardAt(edits).description).toContain("Preview deployment");
    expect(editedCardAt(edits).description).toContain("Run `!deploy`");
    expect(getRestartRequests()).toBe(0);
  });

  test("shows Git-derived remote matches and stable recovery command", async () => {
    const { message, replies } = makeMessage("!deploy status");
    const { context, getRestartRequests } = makeContext({
      async deploymentStatus() {
        return {
          deployedCommit: "2222222222222222222222222222222222222222",
          matchingRemoteRefs: ["origin/feat/user-test"],
          deploymentInProgress: false,
        };
      },
    });

    await handleMessage(message as never, context);

    expect(replyCardAt(replies).title).toBe("Deployment status");
    expect(replyCardAt(replies).description).toContain("origin/feat/user-test");
    expect(replyCardAt(replies).description).toContain("Remote matches:");
    expect(replyCardAt(replies).description).toContain("Return to stable: `!deploy`");
    expect(getRestartRequests()).toBe(0);
  });

  test("rejects malformed deploy command shapes", async () => {
    const { message, replies } = makeMessage("!deploy feat/user-test");
    const { context, getRestartRequests } = makeContext();

    await handleMessage(message as never, context);

    expect(replyTextAt(replies)).toContain("Usage: !deploy branch <branch-name>");
    expect(getRestartRequests()).toBe(0);
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

test("deployment failures deliver every page after editing the progress card", async () => {
  const { message, replies, edits } = makeMessage("!deploy");
  const diagnostics = Array.from({ length: 500 }, (_, i) => `diagnostic-line-${i}: test output`).join("\n");
  const { context } = makeContext({
    async deploy(options) {
      await options.onDeploymentStarted?.();
      return { type: "deployment-failed", message: diagnostics };
    },
  });
  await handleMessage(message as never, context);
  const title = editedCardAt(edits).title;
  const count = Number(title.match(/\(1\/(\d+)\)/)?.[1]);
  expect(count).toBeGreaterThan(1);
  // replies include the initial progress card plus each continuation.
  expect(replies).toHaveLength(count);
  const delivered = [editedCardAt(edits).description, ...replies.slice(1).map((_, i) => replyTextAt(replies, i + 1))].join("\n");
  expect(delivered).toContain("diagnostic-line-499");
  for (let i = 0; i < 500; i++) expect(delivered).toContain(`diagnostic-line-${i}:`);
});

test("deployment diagnostic continuation failures propagate instead of reporting success", async () => {
  const { message } = makeMessage("!deploy");
  const reply = message.reply;
  let calls = 0;
  message.reply = async (payload) => {
    if (++calls > 1) throw new Error("delivery rejected");
    return reply(payload);
  };
  const { context } = makeContext({ async deploy(options) {
    await options.onDeploymentStarted?.();
    return { type: "deployment-failed", message: "diagnostic output\n".repeat(1000) };
  } });
  await expect(handleMessage(message as never, context)).rejects.toThrow("delivery rejected");
});

test("Discord discovers arbitrary agents and routes creation and account reads without identity branches", async () => {
  const { context } = makeContext();
  const provider = "independent-agent";
  const original = context.conversation.listProviders()[0]!;
  context.conversation.listProviders = () => [{ ...original, id: provider, displayName: "Independent agent" }];
  const created: Array<[string, string | undefined]> = [], accounts: string[] = [];
  context.createSurfaceThread = async (id, selected) => { created.push([id, selected]); return "independent-thread"; };
  context.conversation.readAccount = async selected => { accounts.push(selected); return account(selected); };
  const discovery = makeMessage("!providers");
  await handleMessage(discovery.message as never, context);
  expect(replyTextAt(discovery.replies)).toContain("Independent agent");
  expect(replyTextAt(discovery.replies)).toContain(provider);
  await handleMessage(makeMessage(`!newthread ${provider}`).message as never, context);
  expect(created).toEqual([["chan-1", provider]]);
  await handleMessage(makeMessage(`!limits ${provider}`).message as never, context);
  expect(accounts).toEqual([provider]);
  for (const command of ["!newthread unknown", "!limits unknown", `!newthread ${provider} extra`]) {
    const message = makeMessage(command); await handleMessage(message.message as never, context);
    expect(replyTextAt(message.replies)).toContain("!providers");
  }
  expect(created).toHaveLength(1); expect(accounts).toHaveLength(1);
  await handleMessage(makeMessage("!newthread").message as never, context);
  expect(created[1]).toEqual(["chan-1", undefined]);
});

for (const provider of ["neutral fixture", "team/Agent  α", '"literal provider"']) test(`Discord preserves opaque provider ${provider}`, async () => {
  const { context } = makeContext();
  const base = context.conversation.listProviders()[0]!;
  const selected: string[] = [];
  Object.assign(context.conversation, {
    listProviders: () => [{ ...base, id: provider }],
    readAccount: async (value: string) => { selected.push(value); return account(value); },
  });
  context.createSurfaceThread = async (_id, value) => { selected.push(value!); return "created"; };
  for (const command of [`!newthread ${provider}`, `!limits ${provider}`]) {
    await handleMessage(makeMessage(command).message as never, context);
  }
  expect(selected).toEqual([provider, provider]);
});

test("Discord accepts quoted provider selection without splitting the identifier", async () => {
  const { context } = makeContext();
  const base = context.conversation.listProviders()[0]!;
  Object.assign(context.conversation, { listProviders: () => [{ ...base, id: "neutral fixture" }] });
  let selected: string | undefined;
  context.createSurfaceThread = async (_id, provider) => { selected = provider; return "created"; };
  await handleMessage(makeMessage('!newthread "neutral fixture"').message as never, context);
  expect(selected).toBe("neutral fixture");
});

test("Discord preserves case and repeated spaces in opaque effort values", async () => {
  const { context } = makeContext();
  let selected: unknown;
  Object.assign(context.conversation, { setThreadEffort: async (_id: string, effort: unknown) => {
    selected = effort; return { threadId: "thread-1", model: null, currentEffort: null, pendingEffort: effort, supportedEfforts: null, effortOptionsKnown: false };
  } });
  await handleMessage(makeMessage("!effort set Low  Power α").message as never, context);
  expect(selected).toBe("Low  Power α");
});

test("Discord explicit extensionless skill paths work without discovery", async () => {
  const { context, writes } = makeContext({ listSkills: async () => { throw Error("Discovery is unavailable"); } });
  const getState = context.conversation.getThreadState;
  Object.assign(context.conversation, { getThreadState: (id: string) => ({ ...getState(id), capabilities: { ...getState(id).capabilities, skills: false, skillConfig: true } }) });
  await handleMessage(makeMessage("!skill disable --path instructions").message as never, context);
  expect(writes).toEqual([{ threadId: "thread-1", path: "instructions", enabled: false }]);
});

for (const value of ['Case  Sensitive α', 'vendor/model "quoted"', 'C:\\models\\native']) test(`Discord preserves the complete model identity ${value}`, async () => {
  const { context, modelWrites } = makeContext();
  const getState = context.conversation.getThreadState;
  Object.assign(context.conversation, { getThreadState: (id: string) => ({ ...getState(id), capabilities: { ...getState(id).capabilities, modelCatalog: false } }) });
  await handleMessage(makeMessage(`!model set ${value}`).message as never, context);
  expect(modelWrites).toEqual([{ threadId: "thread-1", model: value }]);
});

for (const command of ["!thread", "!threadread", "!fork", "!archive", "!unarchive"]) test(`${command} preserves a quoted thread identity`, async () => {
  const { context } = makeContext(); const ids: string[] = [];
  const value = 'app  thread "α"';
  context.switchSurfaceThread = async (_channel, id) => { ids.push(id); return id; };
  context.forkSurfaceThread = async (_channel, id) => { ids.push(id); return "forked"; };
  Object.assign(context.conversation, {
    readThread: async (id: string) => { ids.push(id); return { thread: { id } }; },
    archiveThread: async (id: string) => { ids.push(id); return { ok: true }; },
    unarchiveThread: async (id: string) => { ids.push(id); return { ok: true }; },
  });
  await handleMessage(makeMessage(`${command} "app  thread \\"α\\""`).message as never, context);
  expect(ids).toEqual([value]);
});

test("history item commands preserve quoted native turn IDs and optional thread IDs", async () => {
  const { context } = makeContext(); const calls: unknown[] = [];
  Object.assign(context.conversation, { listThreadItems: async (threadId: string, request: unknown) => { calls.push({ threadId, request }); return { data: [], nextCursor: null }; } });
  await handleMessage(makeMessage('!history items "native  turn α" "app  thread"').message as never, context);
  expect(calls).toEqual([{ threadId: "app  thread", request: { turnId: "native  turn α", cursor: undefined, limit: 5, sortDirection: "asc" } }]);
});

test("quoted history thread named items does not select item mode", async () => {
  const { context } = makeContext(); const ids: string[] = [];
  Object.assign(context.conversation, { listThreadTurns: async (id: string) => { ids.push(id); return { data: [], nextCursor: null }; } });
  await handleMessage(makeMessage('!history "items"').message as never, context);
  expect(ids).toEqual(["items"]);
});

for (const command of ['!thread "unclosed', '!history items "turn"garbage', '!model set "one" "two"']) test(`invalid argument boundaries never execute ${command}`, async () => {
  const { context, modelWrites } = makeContext(); let calls = 0;
  context.switchSurfaceThread = async () => { calls++; return "wrong"; };
  Object.assign(context.conversation, { listThreadItems: async () => { calls++; throw Error("Must not execute"); } });
  await handleMessage(makeMessage(command).message as never, context);
  expect(calls).toBe(0); expect(modelWrites).toEqual([]);
});
