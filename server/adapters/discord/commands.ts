import type { Message } from "discord.js";

import type { SessionManager } from "../../core/session_manager.js";
import type { ThreadStore } from "./thread_store.js";

export type CommandContext = {
  manager: SessionManager;
  store: ThreadStore;
  ensureChannelThread: (channelId: string) => Promise<string>;
};

export async function handleMessage(
  message: Message,
  context: CommandContext,
): Promise<{ handled: boolean; threadId: string | null; input: string | null }> {
  if (!message.content.trim()) {
    return { handled: true, threadId: null, input: null };
  }

  const content = message.content.trim();
  const channelId = message.channelId;

  if (content === "!help") {
    await message.reply([
      "Discord Codex bridge commands:",
      "- !help",
      "- !newthread",
      "- !thread",
      "Any other message is sent as a Codex turn.",
    ].join("\n"));
    return { handled: true, threadId: null, input: null };
  }

  if (content === "!newthread") {
    context.store.clearThread(channelId);
    const threadId = await context.ensureChannelThread(channelId);
    await message.reply(`Started new thread: ${threadId}`);
    return { handled: true, threadId, input: null };
  }

  if (content === "!thread") {
    const existing = context.store.getThreadId(channelId);
    await message.reply(existing ? `Current thread: ${existing}` : "No thread yet. Send a message to start one.");
    return { handled: true, threadId: existing, input: null };
  }

  const threadId = await context.ensureChannelThread(channelId);
  return { handled: false, threadId, input: content };
}
