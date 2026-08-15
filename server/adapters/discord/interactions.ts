import { MessageFlags, type ButtonInteraction } from "discord.js";

import type { ConversationService } from "../../core/conversation_service.js";
import {
  buildCardPages,
  buildMarkdownPages,
  componentsV2Payload,
  type DiscordSurfacePage,
} from "./components_renderer.js";
import {
  buildLoadedThreadsListPage,
  buildModelsListPage,
  buildStoredThreadsListPage,
  decodeDiscordListPageId,
  DISCORD_LIST_PAGE_SIZE,
} from "./list_pagination.js";
import { decodeApprovalButtonId, formatApprovalDecisionReply } from "./message_renderer.js";

async function replyEphemeralText(interaction: ButtonInteraction, text: string): Promise<void> {
  const page = buildMarkdownPages(text)[0]!;
  await interaction.reply({
    ...componentsV2Payload(page),
    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
  });
}

export async function handleInteraction(
  interaction: ButtonInteraction,
  conversation: ConversationService,
  surfaceContext?: { getSurfaceThreadId: (surfaceId: string) => string | null },
): Promise<void> {
  const pageRequest = decodeDiscordListPageId(interaction.customId);
  if (pageRequest) {
    if (interaction.user.id !== pageRequest.requesterId) {
      await replyEphemeralText(interaction, "Only the person who opened this list can change its page.");
      return;
    }

    let page: DiscordSurfacePage;
    try {
      if (pageRequest.target === "threads-active" || pageRequest.target === "threads-archived") {
        const requestDirection = pageRequest.direction === "asc" ? "asc" : "desc";
        const result = await conversation.listStoredThreads({
          archived: pageRequest.target === "threads-archived",
          cursor: pageRequest.cursor ?? undefined,
          limit: DISCORD_LIST_PAGE_SIZE + (pageRequest.boundaryId ? 1 : 0),
          sortKey: "updated_at",
          sortDirection: requestDirection,
        });
        const threads = pageRequest.boundaryId
          ? result.threads.filter((thread) => thread.threadId !== pageRequest.boundaryId)
          : result.threads;
        page = buildStoredThreadsListPage({
          result: { ...result, threads: threads.slice(0, DISCORD_LIST_PAGE_SIZE) },
          archived: pageRequest.target === "threads-archived",
          requesterId: pageRequest.requesterId,
          page: pageRequest.page,
          requestDirection,
        });
      } else if (pageRequest.target === "threads-loaded") {
        const result = await conversation.listLoadedThreads({
          cursor: pageRequest.cursor ?? undefined,
          limit: DISCORD_LIST_PAGE_SIZE,
        });
        page = buildLoadedThreadsListPage({
          ...result,
          requesterId: pageRequest.requesterId,
          page: pageRequest.page,
        });
      } else {
        const result = await conversation.listModels({
          cursor: pageRequest.cursor ?? undefined,
          limit: DISCORD_LIST_PAGE_SIZE,
        });
        const threadId = surfaceContext?.getSurfaceThreadId(interaction.channelId) ?? null;
        page = buildModelsListPage({
          result,
          modelState: threadId ? conversation.getThreadModel(threadId) : null,
          requesterId: pageRequest.requesterId,
          page: pageRequest.page,
        });
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : "Failed to load this page.";
      const page = buildCardPages({ title: "Pagination failed", text, tone: "danger" })[0]!;
      await interaction.reply({
        ...componentsV2Payload(page),
        flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
      });
      return;
    }
    await interaction.update({
      flags: MessageFlags.IsComponentsV2,
      components: page.components,
      allowedMentions: { parse: [] },
    });
    return;
  }

  const parsed = decodeApprovalButtonId(interaction.customId);
  if (!parsed) return;

  let responseText: string;
  try {
    await conversation.applyApprovalDecision(parsed.threadId, parsed.approvalId, {
      decision: parsed.decision,
    });
    responseText = formatApprovalDecisionReply(parsed.decision);
  } catch (error) {
    responseText = error instanceof Error ? error.message : "Failed to submit decision";
  }
  await replyEphemeralText(interaction, responseText);
}
