import type { APIEmbed, APIEmbedField } from "discord.js";

import type { ApprovalRequestPayload } from "../../../shared/protocol/approvals.js";
import type { BridgeEvent } from "../../../shared/protocol/events.js";
import { formatEventLine } from "./message_renderer.js";

export const DISCORD_EMBED_LIMITS = {
  title: 256,
  description: 4_096,
  fieldName: 256,
  fieldValue: 1_024,
  fields: 25,
  total: 6_000,
} as const;

export const EMBED_COLORS = {
  info: 0x5865f2,
  working: 0xfee75c,
  success: 0x57f287,
  warning: 0xfee75c,
  danger: 0xed4245,
  neutral: 0x99aab5,
} as const;

export type EmbedTone = keyof typeof EMBED_COLORS;

export function isEmbedRejection(error: unknown): boolean {
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  if (record.code === 50_013 || record.code === 50_035) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /embed links|missing permissions|invalid form body/i.test(message);
}

function truncate(value: string, limit: number): string {
  const points = Array.from(value.trim());
  if (points.length <= limit) return points.join("");
  return `${points.slice(0, Math.max(0, limit - 1)).join("")}…`;
}

function textLength(value: string): number {
  return Array.from(value).length;
}

export function buildEmbed(options: {
  title: string;
  tone?: EmbedTone;
  description?: string | null;
  fields?: APIEmbedField[];
  footer?: string | null;
  timestamp?: string;
}): APIEmbed {
  const title = truncate(options.title, DISCORD_EMBED_LIMITS.title);
  let used = textLength(title);
  const embed: APIEmbed = {
    title,
    color: EMBED_COLORS[options.tone ?? "info"],
  };
  if (options.description?.trim()) {
    const remaining = Math.max(0, DISCORD_EMBED_LIMITS.total - used);
    embed.description = truncate(
      options.description,
      Math.min(DISCORD_EMBED_LIMITS.description, remaining),
    );
    used += textLength(embed.description);
  }
  const fields: APIEmbedField[] = [];
  for (const field of (options.fields ?? []).filter((candidate) => candidate.name.trim() && candidate.value.trim())) {
    if (fields.length >= DISCORD_EMBED_LIMITS.fields) break;
    const remaining = DISCORD_EMBED_LIMITS.total - used;
    if (remaining < 2) break;
    const name = truncate(field.name, Math.min(DISCORD_EMBED_LIMITS.fieldName, remaining - 1));
    const valueBudget = Math.min(
      DISCORD_EMBED_LIMITS.fieldValue,
      DISCORD_EMBED_LIMITS.total - used - textLength(name),
    );
    if (valueBudget < 1) break;
    const value = truncate(field.value, valueBudget);
    fields.push({
      name,
      value,
      ...(field.inline === undefined ? {} : { inline: field.inline }),
    });
    used += textLength(name) + textLength(value);
  }
  if (fields.length > 0) embed.fields = fields;
  if (options.footer?.trim() && used < DISCORD_EMBED_LIMITS.total) {
    embed.footer = {
      text: truncate(
        options.footer,
        Math.min(2_048, DISCORD_EMBED_LIMITS.total - used),
      ),
    };
  }
  if (options.timestamp) embed.timestamp = options.timestamp;
  return embed;
}

function splitText(text: string, maxChars: number): string[] {
  if (!text.trim()) return [];
  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining.length > maxChars) {
    const slice = remaining.slice(0, maxChars);
    const boundary = Math.max(slice.lastIndexOf("\n"), slice.lastIndexOf(" "));
    const cut = boundary >= Math.floor(maxChars * 0.55) ? boundary : maxChars;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function buildDescriptionPages(options: {
  title: string;
  text: string;
  tone?: EmbedTone;
  fields?: APIEmbedField[];
  footer?: string;
}): APIEmbed[] {
  const chunks = splitText(options.text, 3_900);
  const pages = chunks.length > 0 ? chunks : [""];
  return pages.map((description, index) =>
    buildEmbed({
      title: options.title,
      tone: options.tone,
      description,
      ...(index === 0 && options.fields ? { fields: options.fields } : {}),
      footer:
        pages.length > 1
          ? `${options.footer ? `${options.footer} · ` : ""}Page ${index + 1}/${pages.length}`
          : options.footer,
    }),
  );
}

export function buildProgressEmbeds(text: string): APIEmbed[] {
  return buildDescriptionPages({ title: "Working", text, tone: "working" });
}

export function buildApprovalEmbed(
  threadId: string,
  approval: ApprovalRequestPayload,
): APIEmbed {
  return buildEmbed({
    title: "Approval required",
    tone: "warning",
    description: approval.prompt.trim(),
    fields: [
      { name: "Action", value: `\`${approval.method}\``, inline: true },
      { name: "Thread", value: `\`${threadId}\``, inline: true },
      {
        name: "Options",
        value: approval.choices.map((choice) => choice.label).join(" · ") || "No choices supplied",
      },
    ],
  });
}

export function buildEventEmbed(event: BridgeEvent): APIEmbed | null {
  const fallback = formatEventLine(event);
  if (!fallback) return null;

  if (event.type === "session.error") {
    const payload = event.payload as { message?: string };
    return buildEmbed({
      title: "Session error",
      tone: "danger",
      description: payload.message ?? "Unknown error.",
    });
  }
  if (event.type === "session.limit.context") {
    return buildEmbed({
      title: "Context limit reached",
      tone: "warning",
      description: "Try `!compact` or start a new thread.",
    });
  }
  if (event.type === "turn.failed") {
    const payload = event.payload as { message?: string };
    return buildEmbed({
      title: "Turn failed",
      tone: "danger",
      description: payload.message ?? "The turn failed before completion.",
    });
  }
  if (event.type === "approval.failed") {
    const payload = event.payload as { message?: string };
    return buildEmbed({
      title: "Approval failed",
      tone: "danger",
      description: payload.message ?? "Unknown error.",
    });
  }
  if (event.type === "turn.notification") {
    const payload = event.payload as { method?: string };
    return buildEmbed({
      title: "Event error",
      tone: "danger",
      description: `Event: ${payload.method ?? "unknown"}`,
    });
  }
  if (event.type === "thread.name.updated") {
    const payload = event.payload as { threadName?: string | null };
    return buildEmbed({
      title: "Thread updated",
      tone: "info",
      fields: [{ name: "Name", value: payload.threadName ?? "untitled" }],
    });
  }
  return buildEmbed({
    title: event.type === "thread.archived" ? "Thread archived" : "Thread unarchived",
    tone: "neutral",
  });
}

export function buildFailureEmbed(title: string, description: string): APIEmbed {
  return buildEmbed({ title, description, tone: "danger" });
}
