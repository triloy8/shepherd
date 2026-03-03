import { MessageFlags, type ButtonInteraction } from "discord.js";

import type { ConversationService } from "../../core/conversation_service.js";
import { decodeApprovalButtonId } from "./message_renderer.js";

export async function handleInteraction(
  interaction: ButtonInteraction,
  conversation: ConversationService,
): Promise<void> {
  const parsed = decodeApprovalButtonId(interaction.customId);
  if (!parsed) return;

  try {
    await conversation.applyApprovalDecision(parsed.threadId, parsed.approvalId, {
      decision: parsed.decision,
    });

    await interaction.reply({
      content: `Decision submitted: ${parsed.decision}`,
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    await interaction.reply({
      content: error instanceof Error ? error.message : "Failed to submit decision",
      flags: MessageFlags.Ephemeral,
    });
  }
}
