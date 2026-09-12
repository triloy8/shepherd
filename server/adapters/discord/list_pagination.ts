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
  boundaryId?: string | null;
};

const TARGET_CODES: Record<DiscordListTarget, string> = {
  "threads-active": "ta",
  "threads-archived": "tr",
  "threads-loaded": "tl",
  models: "m",
  skills: "s",
  "history-turns": "ht",
  "history-items": "hi",
};

const TARGETS_BY_CODE = Object.fromEntries(
  Object.entries(TARGET_CODES).map(([target, code]) => [code, target]),
) as Record<string, DiscordListTarget>;

const DIRECTION_CODES: Record<DiscordListDirection, string> = {
  asc: "a",
  desc: "d",
  forward: "n",
  first: "f",
};

const DIRECTIONS_BY_CODE = Object.fromEntries(
  Object.entries(DIRECTION_CODES).map(([direction, code]) => [code, direction]),
) as Record<string, DiscordListDirection>;

export function encodeDiscordListPageId(request: DiscordListPageRequest): string {
  const encodedCursor = request.cursor ? encodeURIComponent(request.cursor) : "";
  const customId = [
    "page",
    TARGET_CODES[request.target],
    DIRECTION_CODES[request.direction],
    String(request.page),
    request.requesterId,
    encodedCursor,
    request.boundaryId ? encodeURIComponent(request.boundaryId) : "",
  ].join("|");
  if (customId.length > 100) {
    throw new Error("Codex pagination cursor is too long for a Discord component ID.");
  }
  return customId;
}

export function decodeDiscordListPageId(customId: string): DiscordListPageRequest | null {
  const parts = customId.split("|");
  if ((parts.length !== 6 && parts.length !== 7) || parts[0] !== "page") return null;
  const target = TARGETS_BY_CODE[parts[1]!];
  const direction = DIRECTIONS_BY_CODE[parts[2]!];
  const page = Number(parts[3]);
  const requesterId = parts[4] ?? "";
  if (!target || !direction || !Number.isInteger(page) || page < 1 || !requesterId) return null;
  try {
    return {
      target,
      direction,
      page,
      requesterId,
      cursor: parts[5] ? decodeURIComponent(parts[5]) : null,
      boundaryId: parts[6] ? decodeURIComponent(parts[6]) : null,
    };
  } catch {
    return null;
  }
}

export function navigationRow(options: {
  target: DiscordListTarget;
  requesterId: string;
  page: number;
  encode?: (request: DiscordListPageRequest) => string;
  previous?: { cursor: string; direction: DiscordListDirection; boundaryId?: string | null } | null;
  next?: { cursor: string; direction: DiscordListDirection; boundaryId?: string | null } | null;
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
          boundaryId: options.previous.boundaryId,
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
          boundaryId: options.next.boundaryId,
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
  const threads = options.requestDirection === "asc"
    ? [...options.result.threads].reverse()
    : options.result.threads;
  const text = threads.length === 0
    ? (options.archived ? "No archived threads." : "No active threads.")
    : threads.map((thread, index) => {
        const label = formatThreadLabel(thread.name, thread.preview);
        const number = (options.page - 1) * DISCORD_LIST_PAGE_SIZE + index + 1;
        return `**${number}. ${label}**\n\`${thread.threadId}\` · Updated ${formatTimestamp(thread.updatedAt)}`;
      }).join("\n\n");

  const previousCursor = options.requestDirection === "desc"
    ? options.result.backwardsCursor
    : options.result.nextCursor;
  const nextCursor = options.requestDirection === "desc"
    ? options.result.nextCursor
    : options.result.backwardsCursor;
  const row = navigationRow({
    target,
    requesterId: options.requesterId,
    page: options.page,
    previous: options.page > 1 && previousCursor
      ? {
          cursor: previousCursor,
          direction: "asc",
          boundaryId: options.requestDirection === "desc" ? threads[0]?.threadId : null,
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
    lines.push("No models returned by Codex app-server.");
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
