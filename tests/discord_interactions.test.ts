import { describe, expect, test } from "bun:test";
import { ComponentType, MessageFlags } from "discord.js";

import { handleInteraction } from "../server/adapters/discord/interactions.js";
import { encodeDiscordListPageId } from "../server/adapters/discord/list_pagination.js";

function textContent(payload: unknown): string {
  const components = (payload as { components?: unknown[] }).components ?? [];
  const first = components[0];
  const component = (first && typeof first === "object" && "toJSON" in first
    ? (first as { toJSON: () => unknown }).toJSON()
    : first) as { type?: unknown; content?: unknown };
  expect(component.type).toBe(ComponentType.TextDisplay);
  return String(component.content);
}

function allText(value: unknown): string {
  const component = (value && typeof value === "object" && "toJSON" in value
    ? (value as { toJSON: () => unknown }).toJSON()
    : value) as { type?: unknown; content?: unknown; components?: unknown[] };
  if (component.type === ComponentType.TextDisplay) return String(component.content);
  return (component.components ?? []).map(allText).join("\n");
}

describe("Discord interactions", () => {
  test("acknowledges approval decisions with an ephemeral Text Display", async () => {
    const replies: unknown[] = [];
    const interaction = {
      customId: "approval|thread-1|approval-1|approve",
      async reply(payload: unknown) {
        replies.push(payload);
      },
    };

    const conversation = {
      async applyApprovalDecision(
        threadId: string,
        approvalId: string,
        request: { decision: string },
      ) {
        expect(threadId).toBe("thread-1");
        expect(approvalId).toBe("approval-1");
        expect(request).toEqual({ decision: "approve" });
      },
    };

    await handleInteraction(interaction as never, conversation as never);

    expect(replies).toHaveLength(1);
    expect(textContent(replies[0])).toBe("Approval decision recorded: Approved");
    expect((replies[0] as { flags?: unknown }).flags).toBe(
      MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
    );
    expect((replies[0] as { allowedMentions?: unknown }).allowedMentions).toEqual({ parse: [] });
  });

  test("surfaces a rejected Components V2 acknowledgement", async () => {
    let attempts = 0;
    const interaction = {
      customId: "approval|thread-1|approval-1|reject",
      async reply(payload: unknown) {
        attempts += 1;
        expect((payload as { flags?: unknown }).flags).toBe(
          MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
        );
        throw Object.assign(new Error("Invalid Form Body: IS_COMPONENTS_V2"), { code: 50_035 });
      },
    };
    const conversation = { async applyApprovalDecision() {} };

    await expect(handleInteraction(interaction as never, conversation as never)).rejects.toThrow(
      "Invalid Form Body: IS_COMPONENTS_V2",
    );

    expect(attempts).toBe(1);
  });

  test("loads the next stored-thread page directly from the Codex cursor", async () => {
    const updates: unknown[] = [];
    const calls: unknown[] = [];
    const lifecycle: string[] = [];
    const interaction = {
      customId: encodeDiscordListPageId({
        target: "threads-active",
        direction: "desc",
        page: 2,
        requesterId: "user-1",
        cursor: "next-cursor",
      }),
      user: { id: "user-1" },
      channelId: "chan-1",
      async deferUpdate() {
        lifecycle.push("deferred");
      },
      async editReply(payload: unknown) {
        lifecycle.push("edited");
        updates.push(payload);
      },
      async reply() {
        throw new Error("unexpected reply");
      },
    };
    const conversation = {
      async listStoredThreads(request: unknown) {
        lifecycle.push("loaded");
        calls.push(request);
        return {
          threads: [
            { threadId: "thread-6", name: "six", preview: "", updatedAt: 6 },
            { threadId: "thread-7", name: "seven", preview: "", updatedAt: 5 },
          ],
          nextCursor: "next-page",
          backwardsCursor: "previous-page",
        };
      },
    };

    await handleInteraction(interaction as never, conversation as never);

    expect(calls).toEqual([{
      archived: false,
      cursor: "next-cursor",
      limit: 5,
      sortKey: "updated_at",
      sortDirection: "desc",
    }]);
    expect(lifecycle).toEqual(["deferred", "loaded", "edited"]);
    expect(updates).toHaveLength(1);
    expect(allText(updates[0])).toContain("6. six");
    expect(allText(updates[0])).toContain("`thread-6`");
    expect(allText(updates[0])).toContain("7. seven");
    expect(allText(updates[0])).toContain("`thread-7`");
  });

  test("reports pagination failures after acknowledging the interaction", async () => {
    const lifecycle: string[] = [];
    const followUps: unknown[] = [];
    const interaction = {
      customId: encodeDiscordListPageId({
        target: "threads-active",
        direction: "desc",
        page: 2,
        requesterId: "user-1",
        cursor: "next-cursor",
      }),
      user: { id: "user-1" },
      channelId: "chan-1",
      async deferUpdate() {
        lifecycle.push("deferred");
      },
      async followUp(payload: unknown) {
        lifecycle.push("followed-up");
        followUps.push(payload);
      },
    };
    const conversation = {
      async listStoredThreads() {
        lifecycle.push("loaded");
        throw new Error("Codex list failed");
      },
    };

    await handleInteraction(interaction as never, conversation as never);

    expect(lifecycle).toEqual(["deferred", "loaded", "followed-up"]);
    expect(allText(followUps[0])).toContain("Codex list failed");
    expect((followUps[0] as { flags?: unknown }).flags).toBe(
      MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
    );
  });

  test("reverses an ascending Codex page when navigating to newer threads", async () => {
    const updates: unknown[] = [];
    const interaction = {
      customId: encodeDiscordListPageId({
        target: "threads-archived",
        direction: "asc",
        page: 2,
        requesterId: "user-1",
        cursor: "backwards-cursor",
        boundaryId: "current-page-boundary",
      }),
      user: { id: "user-1" },
      channelId: "chan-1",
      async deferUpdate() {},
      async editReply(payload: unknown) {
        updates.push(payload);
      },
      async reply() {
        throw new Error("unexpected reply");
      },
    };
    const conversation = {
      async listStoredThreads(request: { sortDirection: string; limit: number }) {
        expect(request.sortDirection).toBe("asc");
        expect(request.limit).toBe(6);
        return {
          threads: [
            { threadId: "current-page-boundary", name: "boundary", preview: "", updatedAt: 4 },
            { threadId: "older-in-page", name: "older", preview: "", updatedAt: 5 },
            { threadId: "newer-in-page", name: "newer", preview: "", updatedAt: 6 },
          ],
          nextCursor: "newer-page",
          backwardsCursor: "older-page",
        };
      },
    };

    await handleInteraction(interaction as never, conversation as never);

    const rendered = allText(updates[0]);
    expect(rendered).not.toContain("current-page-boundary");
    expect(rendered.indexOf("newer-in-page")).toBeLessThan(rendered.indexOf("older-in-page"));
  });

  test("does not let another Discord user change a paginated list", async () => {
    const replies: unknown[] = [];
    let listCalls = 0;
    const interaction = {
      customId: encodeDiscordListPageId({
        target: "models",
        direction: "forward",
        page: 2,
        requesterId: "user-1",
        cursor: "models-2",
      }),
      user: { id: "user-2" },
      channelId: "chan-1",
      async reply(payload: unknown) {
        replies.push(payload);
      },
    };
    const conversation = {
      async listModels() {
        listCalls += 1;
      },
    };

    await handleInteraction(interaction as never, conversation as never);

    expect(listCalls).toBe(0);
    expect(textContent(replies[0])).toContain("Only the person");
  });

  test("uses the returned forward cursor for model pages", async () => {
    const updates: unknown[] = [];
    const requests: unknown[] = [];
    const interaction = {
      customId: encodeDiscordListPageId({
        target: "models",
        direction: "forward",
        page: 2,
        requesterId: "user-1",
        cursor: "models-page-2",
      }),
      user: { id: "user-1" },
      channelId: "chan-1",
      async deferUpdate() {},
      async editReply(payload: unknown) {
        updates.push(payload);
      },
      async reply() {
        throw new Error("unexpected reply");
      },
    };
    const conversation = {
      async listModels(request: unknown) {
        requests.push(request);
        return {
          data: [{
            id: "model-6",
            model: "model-6",
            displayName: "Model 6",
            description: "",
            hidden: false,
            isDefault: false,
            supportsPersonality: true,
          }],
          nextCursor: null,
        };
      },
      getThreadModel(threadId: string) {
        return { threadId, currentModel: "model-6", modelProvider: "openai", pendingModel: null };
      },
    };

    await handleInteraction(interaction as never, conversation as never, {
      getSurfaceThreadId: () => "thread-1",
    });

    expect(requests).toEqual([{ cursor: "models-page-2", limit: 5 }]);
    expect(allText(updates[0])).toContain("6. `model-6` [current]");
  });

  test("cycles a loaded-thread list back to its first Codex page", async () => {
    const updates: unknown[] = [];
    const requests: unknown[] = [];
    const interaction = {
      customId: encodeDiscordListPageId({
        target: "threads-loaded",
        direction: "first",
        page: 1,
        requesterId: "user-1",
        cursor: null,
      }),
      user: { id: "user-1" },
      channelId: "chan-1",
      async deferUpdate() {},
      async editReply(payload: unknown) {
        updates.push(payload);
      },
      async reply() {
        throw new Error("unexpected reply");
      },
    };
    const conversation = {
      async listLoadedThreads(request: unknown) {
        requests.push(request);
        return { threadIds: ["thread-1"], nextCursor: "loaded-page-2" };
      },
    };

    await handleInteraction(interaction as never, conversation as never);

    expect(requests).toEqual([{ cursor: undefined, limit: 5 }]);
    expect(allText(updates[0])).toContain("1. `thread-1`");
  });
});
