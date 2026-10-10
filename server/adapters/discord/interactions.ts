import { loadSkillsPage } from "../../core/skills_page_service.js";
import { MessageFlags, ModalBuilder, ActionRowBuilder, TextInputBuilder, TextInputStyle, type ModalSubmitInteraction, type ButtonInteraction } from "discord.js";

import type { InteractionConversation } from "../../core/conversation_ports.js";
import {
  buildCardPages,
  buildMarkdownPages,
  componentsV2Payload,
  type DiscordSurfacePage,
} from "./components_renderer.js";
import {
  buildLoadedThreadsListPage,
  buildModelsListPage,
  buildSkillsListPage,
  buildStoredThreadsListPage,
  decodeDiscordListPageId,
  DISCORD_LIST_PAGE_SIZE,
} from "./list_pagination.js";
import { decodeApprovalButtonId, formatApprovalDecisionReply } from "./message_renderer.js";
import { decodeHistoryPageId, loadHistoryPage } from "./history_pagination.js";

async function replyEphemeralText(interaction: ButtonInteraction | ModalSubmitInteraction, text: string): Promise<void> {
  const page = buildMarkdownPages(text)[0]!;
  await interaction.reply({
    ...componentsV2Payload(page),
    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
  });
}

export async function handleModalInteraction(
  interaction: ModalSubmitInteraction,
  conversation: InteractionConversation,
): Promise<void> {
  const parsed = decodeApprovalButtonId(interaction.customId);
  if (!parsed || parsed.decision !== "submit") return;
  try {
    const request = conversation.listApprovals(parsed.threadId).find(a => a.approvalId === parsed.approvalId && a.status === "pending");
    if (!request?.userInput) throw new Error("These questions are no longer pending.");
    const answers = Object.fromEntries(request.userInput.questions.map((q, index) => [q.id, { answers: [interaction.fields.getTextInputValue(`answer-${index}`)] }]));
    await conversation.applyApprovalDecision(parsed.threadId, parsed.approvalId, { decision: "submit", answers });
    await replyEphemeralText(interaction, "Answers submitted.");
  } catch (error) { await replyEphemeralText(interaction, (error as Error).message); }
  return;
}

export async function handleInteraction(
  interaction: ButtonInteraction,
  conversation: InteractionConversation,
  surfaceContext?: { getSurfaceThreadId: (surfaceId: string) => string | null },
): Promise<void> {
  if (interaction.customId.startsWith("history|")) {
    const request = decodeHistoryPageId(interaction.customId);
    if (!request) {
      await replyEphemeralText(interaction, "This history view expired. Run !history again.");
      return;
    }
    if (interaction.user.id !== request.requesterId) {
      await replyEphemeralText(interaction, "Only the person who opened this list can change its page.");
      return;
    }
    await interaction.deferUpdate();
    try {
      const page = await loadHistoryPage(conversation, request);
      await interaction.editReply({ components: page.components, allowedMentions: { parse: [] } });
    } catch (error) {
      const page = buildCardPages({
        title: "History unavailable", tone: "danger",
        text: error instanceof Error ? error.message : "Failed to load history.",
      })[0]!;
      await interaction.followUp({
        ...componentsV2Payload(page),
        flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
      });
    }
    return;
  }
  const pageRequest = decodeDiscordListPageId(interaction.customId);
  if (pageRequest && pageRequest.target !== "history-turns" && pageRequest.target !== "history-items") {
    if (interaction.user.id !== pageRequest.requesterId) {
      await replyEphemeralText(interaction, "Only the person who opened this list can change its page.");
      return;
    }

    await interaction.deferUpdate();

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
      } else if (pageRequest.target === "skills") {
        const threadId = surfaceContext?.getSurfaceThreadId(interaction.channelId);
        if (!threadId) {
          throw new Error("No active thread in this channel. Use `!newthread` or `!thread <id>` first.");
        }
        const result = await loadSkillsPage(conversation, {
          threadId, page: pageRequest.direction === "first" ? 1 : pageRequest.page,
          pageSize: DISCORD_LIST_PAGE_SIZE,
        });
        page = buildSkillsListPage({
          result,
          requesterId: pageRequest.requesterId,
        });
      } else {
        const threadId = surfaceContext?.getSurfaceThreadId(interaction.channelId) ?? null;
        const provider = threadId ? conversation.getThreadProvider?.(threadId) : undefined;
        const result = await conversation.listModels({
          cursor: pageRequest.cursor ?? undefined,
          limit: DISCORD_LIST_PAGE_SIZE,
          ...(provider && provider !== "codex" ? { provider } : {}),
        });
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
      await interaction.followUp({
        ...componentsV2Payload(page),
        flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
      });
      return;
    }
    await interaction.editReply({
      components: page.components,
      allowedMentions: { parse: [] },
    });
    return;
  }

  const parsed = decodeApprovalButtonId(interaction.customId);
  if (!parsed) return;

  const request = ["submit", "cancel"].includes(parsed.decision) ? conversation.listApprovals(parsed.threadId).find(a => a.approvalId === parsed.approvalId && a.status === "pending") : undefined;
  if (request?.userInput && parsed.decision === "submit") {
    if (request.userInput.questions.length > 5 || request.userInput.questions.some(q => q.isSecret || q.multiSelect)) {
      await replyEphemeralText(interaction, "Please answer these questions in the Shepherd web UI.");
      return;
    }
    const modal = new ModalBuilder().setCustomId(interaction.customId).setTitle("Answer Shepherd’s questions");
    request.userInput.questions.forEach((q, index) => {
      const input = new TextInputBuilder().setCustomId(`answer-${index}`).setLabel(q.header.slice(0, 45)).setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000).setPlaceholder((q.options?.map(o => o.label).join(" / ") || q.question).slice(0, 100));
      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    });
    await interaction.showModal(modal);
    return;
  }

  let responseText: string;
  try {
    await conversation.applyApprovalDecision(parsed.threadId, parsed.approvalId, {
      decision: parsed.decision,
    });
    responseText = request?.userInput ? "Questions skipped." : formatApprovalDecisionReply(parsed.decision);
  } catch (error) {
    responseText = error instanceof Error ? error.message : "Failed to submit decision";
  }
  await replyEphemeralText(interaction, responseText);
}
