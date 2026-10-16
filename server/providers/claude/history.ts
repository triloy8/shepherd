import type { SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import type * as P from "../../../shared/protocol/requests.js";
import { archivedTag, type ClaudeNative } from "./native_sessions.js";
import { decodeTranscript, type TranscriptEntry } from "./transcript.js";

/* Stored Claude conversations, read through the SDK. A session running a thread overlays what
 * only this process knows (an in-progress turn, a session not yet created). */

export function paginate<T>(values: T[], request: { cursor?: string; limit?: number }) {
  const offset = request.cursor ? Number(request.cursor) : 0;
  const limit = request.limit ?? 20;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid Claude pagination.");
  return { data: values.slice(offset, offset + limit), nextCursor: offset + limit < values.length ? String(offset + limit) : null, backwardsCursor: null };
}

/** A turn's display summary: what the user sent and the answer, falling back to the last reply. */
function summaryItems(items: P.HistoryItem[]): P.HistoryItem[] {
  const replies = items.filter((item): item is Extract<P.HistoryItem, { type: "assistant_message" }> => item.type === "assistant_message");
  const answers = replies.some((item) => item.phase === "final") ? replies.filter((item) => item.phase === "final") : replies.slice(-1);
  return items.filter((item) => item.type === "user_message" || (item.type === "assistant_message" && answers.includes(item)));
}

export function threadRecord(info: SDKSessionInfo, turns: P.HistoryTurn[] | null, model: string | null = null): P.ThreadRecord {
  return {
    id: info.sessionId, model, name: info.customTitle ?? null, preview: info.firstPrompt ?? info.summary,
    createdAt: (info.createdAt ?? info.lastModified) / 1000, updatedAt: info.lastModified / 1000,
    ...(info.cwd ? { cwd: info.cwd } : {}), ...(turns ? { turns } : {}),
  };
}

export async function sessionInfo(sdk: ClaudeNative, id: string): Promise<SDKSessionInfo> {
  const info = await sdk.getSessionInfo(id);
  if (!info) throw new Error(`Unknown Claude session ${id}.`);
  return info;
}

/** A stored conversation's turns. `activeTurnId` names a turn this process is still running. */
export async function storedTurns(sdk: ClaudeNative, id: string, activeTurnId: string | null = null): Promise<P.HistoryTurn[]> {
  return decodeTranscript(await sdk.getSessionMessages(id) as TranscriptEntry[], activeTurnId).turns;
}

export async function readStoredThread(sdk: ClaudeNative, id: string, includeTurns: boolean): Promise<P.ReadThreadResponse> {
  return { thread: threadRecord(await sessionInfo(sdk, id), includeTurns ? await storedTurns(sdk, id) : null) };
}

export function turnPage(turns: P.HistoryTurn[], request: P.ListThreadTurnsRequest): P.ListThreadTurnsResponse {
  const ordered = request.sortDirection === "asc" ? turns : [...turns].reverse();
  return paginate(ordered.map((turn) => {
    const items = request.itemsView === "none" ? [] : turn.items;
    return { ...turn, itemsView: request.itemsView ?? "full", items: request.itemsView === "summary" ? summaryItems(items) : items };
  }), request);
}

export function itemPage(turns: P.HistoryTurn[], request: P.ListThreadItemsRequest): P.ListThreadItemsResponse {
  const items = turns.filter((t) => !request.turnId || t.id === request.turnId).flatMap((t) => t.items.map((item) => ({ turnId: t.id, item })));
  if (request.sortDirection === "desc") items.reverse();
  return paginate(items, request);
}

export async function listClaudeThreads(sdk: ClaudeNative, request: P.ListStoredThreadsRequest) {
  const archived = request.archived ?? false;
  const threads = (await sdk.listSessions()).filter((info) => (info.tag === archivedTag) === archived
    && (!request.searchTerm || `${info.customTitle ?? ""} ${info.firstPrompt ?? info.summary}`.toLowerCase().includes(request.searchTerm.toLowerCase()))
    && (!request.cwd || (Array.isArray(request.cwd) ? request.cwd.includes(info.cwd ?? "") : request.cwd === info.cwd)));
  const key = (info: SDKSessionInfo) => request.sortKey === "created_at" ? info.createdAt ?? info.lastModified : info.lastModified;
  threads.sort((a, b) => (request.sortDirection === "asc" ? 1 : -1) * (key(a) - key(b)));
  return paginate(threads.map((info) => threadRecord(info, null)), request);
}
