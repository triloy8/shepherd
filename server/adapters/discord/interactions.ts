import { MessageFlags, type ButtonInteraction } from "discord.js";

import type { ConversationService } from "../../core/conversation_service.js";
import {
  buildMarkdownPages,
  componentsV2Payload,
  isComponentsV2Rejection,
} from "./components_renderer.js";
import { decodeApprovalButtonId, formatApprovalDecisionReply } from "./message_renderer.js";

async function replyEphemeralText(interaction: ButtonInteraction, text: string): Promise<void> {
  const page = buildMarkdownPages(text)[0]!;
  try {
    await interaction.reply({
      ...componentsV2Payload(page),
      flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
    });
  } catch (error) {
    if (!isComponentsV2Rejection(error)) throw error;
    await interaction.reply({ content: text, flags: MessageFlags.Ephemeral });
  }
}

export async function handleInteraction(
  interaction: ButtonInteraction,
  conversation: ConversationService,
): Promise<void> {
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
