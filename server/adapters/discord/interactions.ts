import type { ButtonInteraction } from "discord.js";

import type { SessionManager } from "../../core/session_manager.js";
import { decodeApprovalButtonId } from "./message_renderer.js";

export async function handleInteraction(
  interaction: ButtonInteraction,
  manager: SessionManager,
): Promise<void> {
  const parsed = decodeApprovalButtonId(interaction.customId);
  if (!parsed) return;

  try {
    await manager.applyApprovalDecision(parsed.threadId, parsed.approvalId, {
      decision: parsed.decision,
    });

    await interaction.reply({
      content: `Decision submitted: ${parsed.decision}`,
      ephemeral: true,
    });
  } catch (error) {
    await interaction.reply({
      content: error instanceof Error ? error.message : "Failed to submit decision",
      ephemeral: true,
    });
  }
}
