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
}) {
  const writes: Array<{ threadId: string; path: string; enabled: boolean }> = [];
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
    } as unknown as CommandContext["conversation"],
    getActiveThreadId() {
      return "thread-1";
    },
    getChannelRepo() {
      return null;
    },
    async setChannelRepo() {
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

  return { context, writes };
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
});
