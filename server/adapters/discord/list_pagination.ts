import { randomUUID } from "node:crypto";
import type { SkillsPage } from "../../core/skills_page_service.js";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";

import type {
  ListModelsResponse,
  ListStoredThreadsResponse,
  ThreadModelState,
} from "../../../shared/protocol/requests.js";
import { buildCardPages, type DiscordSurfacePage } from "./components_renderer.js";

export const DISCORD_LIST_PAGE_SIZE = 5;

export type DiscordListTarget = "threads-active" | "threads-archived" | "threads-loaded" | "models" | "skills" | "history-turns" | "history-items";
export type DiscordListDirection = "asc" | "desc" | "forward" | "first";

export type DiscordListPageRequest = {
  target: DiscordListTarget;
  direction: DiscordListDirection;
  page: number;
  requesterId: string;
  cursor: string | null;
};

// Keep application cursors server-side: Discord component IDs are limited to 100 characters.
const controls = new Map<string, { request: DiscordListPageRequest; expiresAt: number }>();
const CONTROL_TTL_MS = 60 * 60 * 1000;
const MAX_CONTROLS = 2000;

export function encodeDiscordListPageId(request: DiscordListPageRequest): string {
  const now = Date.now();
  for (const [id, entry] of controls) if (entry.expiresAt <= now) controls.delete(id);
  while (controls.size >= MAX_CONTROLS) controls.delete(controls.keys().next().value!);
  const id = `page|${randomUUID()}`;
  controls.set(id, { request: structuredClone(request), expiresAt: now + CONTROL_TTL_MS });
  return id;
}

export function decodeDiscordListPageId(id: string): DiscordListPageRequest | null {
  const entry = controls.get(id);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) { controls.delete(id); return null; }
  return structuredClone(entry.request);
}

export function navigationRow(options: {
  target: DiscordListTarget;
  requesterId: string;
  page: number;
  encode?: (request: DiscordListPageRequest) => string;
  previous?: { cursor: string; direction: DiscordListDirection } | null;
  next?: { cursor: string; direction: DiscordListDirection } | null;
}): ActionRowBuilder<ButtonBuilder> {
  const encode = options.encode ?? encodeDiscordListPageId;
  const first = new ButtonBuilder()
    .setCustomId(encode({
      target: options.target,
      direction: "first",
      page: 1,
      requesterId: options.requesterId,
      cursor: null,
    }))
    .setLabel("First")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(options.page === 1);
  const previous = new ButtonBuilder()
    .setCustomId(options.previous
      ? encode({
          target: options.target,
          direction: options.previous.direction,
          page: Math.max(1, options.page - 1),
          requesterId: options.requesterId,
          cursor: options.previous.cursor,
        })
      : `page-disabled-prev-${options.page}`)
    .setLabel("Previous")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(!options.previous);
  const indicator = new ButtonBuilder()
    .setCustomId(`page-indicator-${options.page}`)
    .setLabel(`Page ${options.page}`)
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(true);
  const next = new ButtonBuilder()
    .setCustomId(options.next
      ? encode({
          target: options.target,
          direction: options.next.direction,
          page: options.page + 1,
          requesterId: options.requesterId,
          cursor: options.next.cursor,
        })
      : `page-disabled-next-${options.page}`)
    .setLabel("Next")
    .setStyle(ButtonStyle.Primary)
    .setDisabled(!options.next);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(first, previous, indicator, next);
}

function formatTimestamp(seconds: number | null): string {
  if (!seconds) return "unknown";
  return `<t:${Math.floor(seconds)}:R>`;
}

function formatThreadLabel(name: string | null, preview: string): string {
  const source = name?.trim() || preview.trim() || "Untitled thread";
  const singleLine = source.replace(/\s+/g, " ");
  const shortened = singleLine.length > 80 ? `${singleLine.slice(0, 77)}…` : singleLine;
  return shortened.replace(/([\\`*_{}[\]()<>#+.!|~-])/g, "\\$1");
}

export function buildStoredThreadsListPage(options: {
  result: ListStoredThreadsResponse;
  archived: boolean;
  requesterId: string;
  page: number;
  requestDirection: "asc" | "desc";
}): DiscordSurfacePage {
  const title = options.archived ? "Archived threads" : "Active threads";
  const target: DiscordListTarget = options.archived ? "threads-archived" : "threads-active";
  const threads = options.result.threads;
  const text = threads.length === 0
    ? (options.archived ? "No archived threads." : "No active threads.")
    : threads.map((thread, index) => {
        const label = formatThreadLabel(thread.name, thread.preview);
        const number = (options.page - 1) * DISCORD_LIST_PAGE_SIZE + index + 1;
        return `**${number}. ${label}**\n\`${thread.threadId}\` · Updated ${formatTimestamp(thread.updatedAt)}`;
      }).join("\n\n");

  const previousCursor = options.result.backwardsCursor;
  const nextCursor = options.result.nextCursor;
  const row = navigationRow({
    target,
    requesterId: options.requesterId,
    page: options.page,
    previous: options.page > 1 && previousCursor
      ? {
          cursor: previousCursor,
          direction: "asc",
        }
      : null,
    next: nextCursor ? { cursor: nextCursor, direction: "desc" } : null,
  });
  return buildCardPages({
    title,
    text,
    tone: options.archived ? "neutral" : "info",
    actionRows: [row],
  })[0]!;
}

export function buildLoadedThreadsListPage(options: {
  threadIds: string[];
  nextCursor: string | null;
  requesterId: string;
  page: number;
}): DiscordSurfacePage {
  const text = options.threadIds.length > 0
    ? options.threadIds.map((threadId, index) =>
        `${(options.page - 1) * DISCORD_LIST_PAGE_SIZE + index + 1}. \`${threadId}\``).join("\n")
    : "No loaded threads.";
  return buildCardPages({
    title: "Loaded threads",
    text,
    tone: "info",
    actionRows: [navigationRow({
      target: "threads-loaded",
      requesterId: options.requesterId,
      page: options.page,
      next: options.nextCursor ? { cursor: options.nextCursor, direction: "forward" } : null,
    })],
  })[0]!;
}

function formatModelEntry(
  model: ListModelsResponse["data"][number],
  index: number,
  modelState: ThreadModelState | null,
  defaultModel: string | null,
): string {
  const flags: string[] = [];
  if (model.model === modelState?.currentModel) flags.push("current");
  if (model.model === modelState?.pendingModel) flags.push("pending");
  if (model.model === defaultModel || model.isDefault) flags.push("default");
  const description = model.description ? ` - ${model.description}` : "";
  const suffix = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
  return `${index}. \`${model.model}\`${suffix}${description}`;
}

export function buildModelsListPage(options: {
  result: ListModelsResponse;
  modelState: ThreadModelState | null;
  requesterId: string;
  page: number;
}): DiscordSurfacePage {
  const defaultEntry = options.result.data.find((entry) => entry.isDefault) ?? null;
  const lines: string[] = [];
  if (options.modelState) {
    lines.push(`- Thread: ${options.modelState.threadId}`);
    lines.push(`- Current: ${options.modelState.currentModel ?? "unknown"}`);
    if (options.modelState.pendingModel) {
      lines.push(`- Pending next turn: ${options.modelState.pendingModel}`);
    }
  }
  if (defaultEntry) lines.push(`- App default: ${defaultEntry.model}`);
  if (lines.length > 0) lines.push("");
  if (options.result.data.length === 0) {
    lines.push("No models returned by the provider.");
  } else {
    const offset = (options.page - 1) * DISCORD_LIST_PAGE_SIZE;
    for (const [index, entry] of options.result.data.entries()) {
      lines.push(formatModelEntry(entry, offset + index + 1, options.modelState, defaultEntry?.model ?? null));
    }
  }
  return buildCardPages({
    title: "Models",
    text: lines.join("\n"),
    tone: "info",
    actionRows: [navigationRow({
      target: "models",
      requesterId: options.requesterId,
      page: options.page,
      next: options.result.nextCursor
        ? { cursor: options.result.nextCursor, direction: "forward" }
        : null,
    })],
  })[0]!;
}

// Render the shared page without applying Discord limits to the underlying data.
export function buildSkillsListPage(options: {
  result: SkillsPage;
  requesterId: string;
}): DiscordSurfacePage {
  const brief = (value: string, limit: number): string => {
    const text = value.replace(/\s+/g, " ").trim();
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
  };
  const { page, offset, previousPage, nextPage } = options.result;
  const text = options.result.entries.map((entry, index) => {
    const label = entry.kind === "skill" ? formatThreadLabel(entry.skill.name, "") : "Skill discovery error";
    const detail = entry.kind === "skill"
      ? `[${entry.skill.scope}] ${entry.skill.enabled ? "enabled" : "disabled"}`
      : brief(entry.error.path, 100);
    const description = brief(entry.kind === "skill" ? entry.skill.description : entry.error.message, 300);
    return `**${offset + index + 1}. ${label}**\n${detail} · cwd: ${brief(entry.cwd, 100)}${description ? `\n${description}` : ""}`;
  }).join("\n\n") || "No skills found.";
  return buildCardPages({
    title: "Skills",
    text,
    tone: "info",
    actionRows: [navigationRow({
      target: "skills",
      requesterId: options.requesterId,
      page,
      previous: previousPage ? { cursor: String(previousPage), direction: "asc" } : null,
      next: nextPage ? { cursor: String(nextPage), direction: "forward" } : null,
    })],
  })[0]!;
}
