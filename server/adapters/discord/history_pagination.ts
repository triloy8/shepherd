import { randomUUID } from "node:crypto";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

import type { ConversationService } from "../../core/conversation_service.js";
import type { HistoryItem } from "../../../shared/protocol/requests.js";
import { buildCardPages, type DiscordSurfacePage } from "./components_renderer.js";
import { DISCORD_LIST_PAGE_SIZE, navigationRow } from "./list_pagination.js";
import { mapTurnActivity } from "../../core/codex_rpc_mapper.js";
import { formatActivityLine } from "./message_renderer.js";
import { chunkForDiscord } from "./chunking.js";
import { normalizeDiscordMarkdown } from "./markdown_normalizer.js";

type HistoryRequest = {
  threadId: string;
  turnId?: string;
  view: "turns" | "items";
  turnsPage?: HistoryRequest;
  detail?: { title: string; text: string; parent: HistoryRequest };
  requesterId: string;
  page: number;
  cursors: Array<string | null>;
};

// Opaque API cursors plus thread/turn IDs cannot reliably fit Discord's 100-character IDs.
const controls = new Map<string, { request: HistoryRequest; expiresAt: number }>();
const HISTORY_TTL_MS = 60 * 60 * 1000;
const MAX_HISTORY_CONTROLS = 2000;

function encode(request: HistoryRequest): string {
  const now = Date.now();
  for (const [key, value] of controls) {
    if (value.expiresAt <= now) controls.delete(key);
  }
  while (controls.size >= MAX_HISTORY_CONTROLS) controls.delete(controls.keys().next().value!);
  const id = `history|${randomUUID()}`;
  controls.set(id, { request, expiresAt: now + HISTORY_TTL_MS });
  return id;
}

export function decodeHistoryPageId(id: string): HistoryRequest | null {
  const entry = controls.get(id);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    controls.delete(id);
    return null;
  }
  return entry.request;
}

function excerpt(value: string, limit = 260): string {
  const text = value.replace(/\s+/g, " ").trim();
  const shortened = text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
  return shortened.replace(/([\\`*_{}[\]()<>#+.!|~-])/g, "\\$1");
}

function itemLabel(item: HistoryItem): string {
  switch (item.type) {
    case "userMessage": return "User message";
    case "agentMessage": return "Assistant message";
    case "plan": return "Plan";
    case "reasoning": return "Reasoning summary";
    default: return mapTurnActivity({ item }, "completed")?.label ?? "Activity";
  }
}

function itemText(item: HistoryItem): string {
  if (item.type === "userMessage") {
    const content = Array.isArray(item.content) ? item.content : [];
    return content.map((value) => {
      const input = value as Record<string, unknown>;
      return typeof input.text === "string" ? input.text : `[${input.type ?? "attachment"}]`;
    }).join(" ");
  }
  if (item.type === "agentMessage" || item.type === "plan") return String(item.text ?? "");
  if (item.type === "reasoning") return Array.isArray(item.summary) ? item.summary.join(" ") : "";
  const activity = mapTurnActivity({ item }, "completed");
  return activity ? formatActivityLine(activity) : item.type;
}

export function initialHistoryRequest(threadId: string, requesterId: string, turnId?: string): HistoryRequest {
  return { threadId, requesterId, turnId, view: turnId ? "items" : "turns", page: 1, cursors: [null] };
}

export async function loadHistoryPage(
  conversation: Pick<ConversationService, "listThreadTurns" | "listThreadItems">,
  request: HistoryRequest,
): Promise<DiscordSurfacePage> {
  if (request.detail) {
    const chunks = chunkForDiscord(normalizeDiscordMarkdown(request.detail.text || "(No text)"), {
      maxChars: 2800, includePageIndicators: false,
    });
    const navigation = navigationRow({
      target: "history-items", requesterId: request.requesterId, page: request.page,
      previous: request.page > 1 ? { cursor: "", direction: "forward" } : null,
      next: request.page < chunks.length ? { cursor: "", direction: "forward" } : null,
      encode: (page) => encode({ ...request, page: page.page }),
    });
    const back = new ButtonBuilder().setCustomId(encode(request.detail.parent))
      .setLabel("Back to items").setStyle(ButtonStyle.Secondary);
    return buildCardPages({
      title: request.detail.title,
      text: chunks[request.page - 1] ?? "(No text)",
      actionRows: [navigation, new ActionRowBuilder<ButtonBuilder>().addComponents(back)],
    })[0]!;
  }
  const cursor = request.cursors[request.page - 1] ?? undefined;
  const common = { cursor, limit: DISCORD_LIST_PAGE_SIZE };
  const offset = (request.page - 1) * DISCORD_LIST_PAGE_SIZE;
  let nextCursor: string | null;
  let text: string;
  const detailButtons: ButtonBuilder[] = [];
  if (request.view === "turns") {
    const result = await conversation.listThreadTurns(request.threadId, {
      ...common, sortDirection: "desc", itemsView: "summary",
    });
    nextCursor = result.nextCursor;
    text = result.data.map((turn, index) => {
      const number = offset + index + 1;
      detailButtons.push(new ButtonBuilder()
        .setCustomId(encode({ ...initialHistoryRequest(request.threadId, request.requesterId, turn.id), turnsPage: request }))
        .setLabel(`Items ${number}`).setStyle(ButtonStyle.Secondary));
      const preview = turn.items.find((item) => item.type === "userMessage")
        ?? turn.items.find((item) => item.type === "agentMessage");
      const when = turn.startedAt ? ` · <t:${Math.floor(turn.startedAt)}:R>` : "";
      return `**${number}. ${turn.status === "inProgress" ? "In progress" : turn.status[0]!.toUpperCase() + turn.status.slice(1)}**${when}\n\`${turn.id}\`${preview ? `\n${excerpt(itemText(preview), 180)}` : ""}${turn.error ? `\nError: ${excerpt(turn.error.message, 80)}` : ""}`;
    }).join("\n\n") || "No turns found.";
  } else {
    const result = await conversation.listThreadItems(request.threadId, {
      ...common, turnId: request.turnId, sortDirection: "asc",
    });
    nextCursor = result.nextCursor;
    text = result.data.map(({ item }, index) => {
      detailButtons.push(new ButtonBuilder()
        .setCustomId(encode({
          ...request, page: 1,
          detail: { title: `History: ${itemLabel(item)}`, text: itemText(item), parent: request },
        }))
        .setLabel(`Read ${offset + index + 1}`).setStyle(ButtonStyle.Secondary));
      return `**${offset + index + 1}. ${excerpt(itemLabel(item), 50)}**\n${excerpt(itemText(item))}`;
    }).join("\n\n") || "No items found.";
  }
  const cursors = request.cursors.slice(0, request.page);
  if (nextCursor) cursors.push(nextCursor);
  const navigation = navigationRow({
    target: request.view === "turns" ? "history-turns" : "history-items",
    requesterId: request.requesterId,
    page: request.page,
    // Previous reuses an already visited cursor, avoiding inclusive reverse anchors.
    previous: request.page > 1 ? { cursor: cursors[request.page - 2] ?? "", direction: "forward" } : null,
    next: nextCursor ? { cursor: nextCursor, direction: "forward" } : null,
    encode: (page) => encode({ ...request, page: page.page, cursors: cursors.slice(0, page.page) }),
  });
  const location = `Thread: \`${request.threadId}\`${request.turnId ? `\nTurn: \`${request.turnId}\`` : ""}`;
  return buildCardPages({
    title: request.view === "turns" ? "Thread history" : "Turn items",
    text: `${location}\n\n${text}`,
    actionRows: [
      navigation,
      ...(detailButtons.length ? [new ActionRowBuilder<ButtonBuilder>().addComponents(...detailButtons)] : []),
      ...(request.view === "items" ? [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(encode(request.turnsPage ?? initialHistoryRequest(request.threadId, request.requesterId)))
          .setLabel("Back to turns").setStyle(ButtonStyle.Secondary),
      )] : []),
    ],
  })[0]!;
}
