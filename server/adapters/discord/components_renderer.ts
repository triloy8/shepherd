import {
  ContainerBuilder,
  MessageFlags,
  TextDisplayBuilder,
  type ActionRowBuilder,
  type ButtonBuilder,
  type MessageCreateOptions,
} from "discord.js";

import type { ApprovalRequestPayload } from "../../../shared/protocol/approvals.js";
import type { BridgeEvent } from "../../../shared/protocol/events.js";
import { chunkForDiscord } from "./chunking.js";
import { formatEventLine } from "./message_renderer.js";

export const DISCORD_TEXT_DISPLAY_LIMIT = 4_000;
export const DISCORD_TEXT_DISPLAY_TARGET = 3_900;
export const DISCORD_CARD_TEXT_TARGET = 3_700;

export const SURFACE_COLORS = {
  info: 0x5865f2,
  working: 0xfee75c,
  success: 0x57f287,
  warning: 0xfee75c,
  danger: 0xed4245,
  neutral: 0x99aab5,
} as const;

export type SurfaceTone = keyof typeof SURFACE_COLORS;

export type DiscordSurfacePage = {
  components: NonNullable<MessageCreateOptions["components"]>;
};

function normalizedText(text: string): string {
  return text.trim() || "\u200b";
}

function markdownChunks(text: string, maxChars: number): string[] {
  return chunkForDiscord(normalizedText(text), {
    maxChars,
    includePageIndicators: false,
  });
}

export function buildMarkdownPages(
  text: string,
  options: { maxChars?: number } = {},
): DiscordSurfacePage[] {
  return markdownChunks(text, options.maxChars ?? DISCORD_TEXT_DISPLAY_TARGET).map((content) => ({
    components: [new TextDisplayBuilder().setContent(content)],
  }));
}

export function buildCardPages(options: {
  title: string;
  text?: string | null;
  tone?: SurfaceTone;
  actionRows?: ActionRowBuilder<ButtonBuilder>[];
  maxChars?: number;
}): DiscordSurfacePage[] {
  const chunks = markdownChunks(options.text ?? "", options.maxChars ?? DISCORD_CARD_TEXT_TARGET);
  const totalPages = chunks.length;

  return chunks.map((content, index) => {
    const pageTitle = totalPages > 1
      ? `${options.title} (${index + 1}/${totalPages})`
      : options.title;
    const container = new ContainerBuilder()
      .setAccentColor(SURFACE_COLORS[options.tone ?? "info"])
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`## ${pageTitle}`),
        new TextDisplayBuilder().setContent(content),
      );
    if (index === 0 && options.actionRows?.length) {
      container.addActionRowComponents(...options.actionRows);
    }
    return {
      components: [container],
    };
  });
}

export function buildProgressPages(text: string): DiscordSurfacePage[] {
  return buildCardPages({
    title: "Working",
    text,
    tone: "working",
    // Keep progress fallbacks editable as ordinary Discord messages.
    maxChars: 1_750,
  });
}

export function buildApprovalPages(
  threadId: string,
  approval: ApprovalRequestPayload,
  actionRows: ActionRowBuilder<ButtonBuilder>[],
): DiscordSurfacePage[] {
  const details = [
    approval.prompt.trim(),
    "",
    `**Action:** \`${approval.method}\``,
    `**Thread:** \`${threadId}\``,
    ...(approval.choices.length > 0
      ? [`**Options:** ${approval.choices.map((choice) => choice.label).join(" · ")}`]
      : []),
  ].join("\n");
  return buildCardPages({
    title: "Approval required",
    text: details,
    tone: "warning",
    actionRows,
  });
}

export function buildEventPages(event: BridgeEvent): DiscordSurfacePage[] {
  const text = formatEventLine(event);
  if (!text) return [];

  if (event.type === "session.error") {
    const payload = event.payload as { message?: string };
    return buildCardPages({
      title: "Session error",
      text: payload.message ?? "Unknown error.",
      tone: "danger",
    });
  }
  if (event.type === "session.limit.context") {
    return buildCardPages({
      title: "Context limit reached",
      text: "Try `!compact` or start a new thread.",
      tone: "warning",
    });
  }
  if (event.type === "turn.failed") {
    const payload = event.payload as { message?: string };
    return buildCardPages({
      title: "Turn failed",
      text: payload.message ?? "The turn failed before completion.",
      tone: "danger",
    });
  }
  if (event.type === "approval.failed") {
    const payload = event.payload as { message?: string };
    return buildCardPages({
      title: "Approval failed",
      text: payload.message ?? "Unknown error.",
      tone: "danger",
    });
  }
  if (event.type === "turn.notification") {
    const payload = event.payload as { method?: string };
    return buildCardPages({
      title: "Event error",
      text: `Event: ${payload.method ?? "unknown"}`,
      tone: "danger",
    });
  }
  if (event.type === "thread.name.updated") {
    const payload = event.payload as { threadName?: string | null };
    return buildCardPages({ title: "Thread updated", text: `**Name:** ${payload.threadName ?? "untitled"}` });
  }
  return buildCardPages({
    title: event.type === "thread.archived" ? "Thread archived" : "Thread unarchived",
    text,
    tone: "neutral",
  });
}

export function componentsV2Payload(
  page: DiscordSurfacePage,
  options: { replyToMessageId?: string | null } = {},
): MessageCreateOptions {
  return {
    flags: MessageFlags.IsComponentsV2,
    components: page.components,
    allowedMentions: {
      parse: [],
      ...(options.replyToMessageId ? { repliedUser: false } : {}),
    },
    ...(options.replyToMessageId
      ? {
          reply: {
            messageReference: options.replyToMessageId,
            failIfNotExists: false,
          },
        }
      : {}),
  };
}
