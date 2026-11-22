import type { HistoryItemsView, HistoryTurn, ListThreadTurnsRequest, ListThreadTurnsResponse } from "../../../shared/protocol/requests.js";

/** Locate a turn using the provider's existing history cursor. */
export async function findThreadTurn(
  listThreadTurns: (threadId: string, request: ListThreadTurnsRequest) => Promise<ListThreadTurnsResponse>,
  threadId: string,
  turnId: string,
  itemsView: HistoryItemsView,
): Promise<HistoryTurn | null> {
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  do {
    const page = await listThreadTurns(threadId, { cursor, limit: 20, sortDirection: "desc", itemsView });
    const turn = page.data.find(candidate => candidate.id === turnId);
    if (turn) return turn;
    cursor = page.nextCursor ?? undefined;
    if (cursor && seenCursors.has(cursor)) throw new Error("History repeated its cursor before the requested turn was found.");
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  return null;
}
