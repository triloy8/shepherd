import type {
  ListThreadItemsRequest, ListThreadItemsResponse,
  ListThreadTurnsRequest, ListThreadTurnsResponse,
} from "../../shared/protocol/requests.js";

export interface HistoryPageRequest {
  threadId: string;
  turnId?: string;
  view: "turns" | "items";
  page: number;
  pageSize: number;
  cursors: Array<string | null>;
  turnsPage?: HistoryPageRequest;
}

export interface HistoryPageSource {
  listThreadTurns(threadId: string, request: ListThreadTurnsRequest): Promise<ListThreadTurnsResponse>;
  listThreadItems(threadId: string, request: ListThreadItemsRequest): Promise<ListThreadItemsResponse>;
}

type HistoryPageNavigation = {
  request: HistoryPageRequest;
  offset: number;
  first: HistoryPageRequest;
  previous: HistoryPageRequest | null;
  next: HistoryPageRequest | null;
};

export type HistoryPage = HistoryPageNavigation & (
  | { view: "turns"; result: ListThreadTurnsResponse }
  | { view: "items"; result: ListThreadItemsResponse }
);

export function initialHistoryPage(threadId: string, pageSize: number, turnId?: string): HistoryPageRequest {
  const request: HistoryPageRequest = {
    threadId, turnId, pageSize, view: turnId ? "items" : "turns", page: 1, cursors: [null],
  };
  validateRequest(request);
  return request;
}

export function openHistoryTurn(request: HistoryPageRequest, turnId: string): HistoryPageRequest {
  return { ...initialHistoryPage(request.threadId, request.pageSize, turnId), turnsPage: request };
}

export function returnToHistoryTurns(request: HistoryPageRequest): HistoryPageRequest {
  return request.turnsPage ?? initialHistoryPage(request.threadId, request.pageSize);
}

function validateRequest(request: HistoryPageRequest): void {
  if (!Number.isSafeInteger(request.page) || request.page < 1
    || !Number.isSafeInteger(request.pageSize) || request.pageSize < 1) {
    throw new Error("Page and page size must be positive integers.");
  }
  if (!request.threadId.trim()) throw new Error("A thread id is required.");
  if (request.cursors.length < request.page || request.cursors[0] !== null
    || request.cursors.slice(1, request.page).some((cursor) => typeof cursor !== "string" || !cursor)) {
    throw new Error("History navigation requires a cursor for every visited page.");
  }
}

function navigation(request: HistoryPageRequest, nextCursor: string | null): HistoryPageNavigation {
  const cursors = request.cursors.slice(0, request.page);
  const at = (page: number): HistoryPageRequest => ({ ...request, page, cursors: cursors.slice(0, page) });
  const first = at(1);
  const previous = request.page > 1 ? at(request.page - 1) : null;
  // Reuse visited forward cursors: reverse cursors may include their anchor again.
  if (nextCursor) cursors.push(nextCursor);
  return {
    request, offset: (request.page - 1) * request.pageSize,
    first, previous, next: nextCursor ? at(request.page + 1) : null,
  };
}

export async function loadHistoryPage(source: HistoryPageSource, request: HistoryPageRequest): Promise<HistoryPage> {
  validateRequest(request);
  const common = { cursor: request.cursors[request.page - 1] ?? undefined, limit: request.pageSize };
  if (request.view === "turns") {
    const result = await source.listThreadTurns(request.threadId, {
      ...common, sortDirection: "desc", itemsView: "summary",
    });
    return { ...navigation(request, result.nextCursor), view: "turns", result };
  }
  const result = await source.listThreadItems(request.threadId, {
    ...common, turnId: request.turnId, sortDirection: "asc",
  });
  return { ...navigation(request, result.nextCursor), view: "items", result };
}
