import type { AgentProvider, ListStoredThreadsRequest, ListStoredThreadsResponse, ThreadRecord } from "../../shared/protocol/requests.js";
import type { StoredThreadPage } from "./agent_session.js";
import type { ThreadProviderDirectory } from "./agent_provider.js";

const prefix = "shepherd-providers:";
type Position = { cursor?: string; skip: number; done: boolean; size?: number };
type Sources = {
  providers: readonly AgentProvider[];
  hasStoredThreads(provider: AgentProvider, request: ListStoredThreadsRequest): boolean;
  listPage(provider: AgentProvider, request: ListStoredThreadsRequest): Promise<StoredThreadPage>;
  directory: ThreadProviderDirectory;
};

export function threadSummary(thread: ThreadRecord, archived: boolean) {
  const string = (value: unknown): string | null => typeof value === "string" && value.trim() ? value : null;
  const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
  return { threadId: thread.id, name: string(thread.name), preview: string(thread.preview) ?? "", archived,
    createdAt: number(thread.createdAt), updatedAt: number(thread.updatedAt), source: string(thread.source), cwd: string(thread.cwd) };
}

/** Merge sorted provider pages. Refill a depleted source before selecting the next row. */
export async function listProviderThreads(sources: Sources, request: ListStoredThreadsRequest): Promise<ListStoredThreadsResponse> {
  const combined = request.cursor?.startsWith(prefix);
  const primary = sources.providers[0];
  if (!primary) return { threads: [], nextCursor: null, backwardsCursor: null };
  const additional = sources.providers.filter(provider => provider !== primary);
  if (!combined && !additional.some(provider => sources.hasStoredThreads(provider, request))) {
    const page = await sources.listPage(primary, request);
    return { threads: page.data.map(thread => { sources.directory.bind(thread.id, primary); return threadSummary(thread, request.archived === true); }), nextCursor: page.nextCursor, backwardsCursor: page.backwardsCursor ?? null };
  }
  const limit = request.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid provider thread page size.");
  let positions = Object.fromEntries(sources.providers.map(provider => [provider, { ...(provider === primary ? { cursor: request.cursor } : {}), skip: 0, done: false }])) as Record<AgentProvider, Position>;
  if (combined) {
    try {
      positions = JSON.parse(Buffer.from(request.cursor!.slice(prefix.length), "base64url").toString());
      for (const provider of sources.providers) {
        const position = positions[provider];
        if (!position || !Number.isSafeInteger(position.skip) || position.skip < 0 || typeof position.done !== "boolean" || (position.cursor !== undefined && typeof position.cursor !== "string") || (position.size !== undefined && (!Number.isSafeInteger(position.size) || position.size < 1))) throw new Error();
      }
    } catch { throw new Error("Invalid provider thread cursor."); }
  }
  const pages = new Map<AgentProvider, StoredThreadPage>();
  const visited = new Map<AgentProvider, Set<string>>();
  async function head(provider: AgentProvider): Promise<ThreadRecord | null> {
    const position = positions[provider];
    while (!position.done) {
      let page = pages.get(provider);
      if (!page) {
        const seen = visited.get(provider) ?? new Set<string>(); visited.set(provider, seen);
        const cursor = position.cursor ?? "";
        if (seen.has(cursor)) throw new Error("Provider returned a repeated thread cursor.");
        seen.add(cursor); position.size ??= limit;
        page = await sources.listPage(provider, { ...request, cursor: position.cursor, limit: position.size });
        pages.set(provider, page);
        if (position.skip > page.data.length) throw new Error("Provider thread page changed; reload the conversation list.");
      }
      if (position.skip < page.data.length) return page.data[position.skip]!;
      position.cursor = page.nextCursor ?? undefined; position.skip = 0; position.done = page.nextCursor === null;
      delete position.size; pages.delete(provider);
    }
    return null;
  }
  const selected: ListStoredThreadsResponse["threads"] = [];
  const key = request.sortKey === "created_at" ? "createdAt" : "updatedAt";
  while (selected.length < limit) {
    const candidates = (await Promise.all(sources.providers.map(async provider => ({ provider, thread: await head(provider) })))).filter((value): value is { provider: AgentProvider; thread: ThreadRecord } => value.thread !== null);
    if (!candidates.length) break;
    candidates.sort((a, b) => (request.sortDirection === "asc" ? 1 : -1) * ((a.thread[key] ?? 0) - (b.thread[key] ?? 0)) || a.provider.localeCompare(b.provider) || a.thread.id.localeCompare(b.thread.id));
    const { provider, thread } = candidates[0]!;
    sources.directory.bind(thread.id, provider); selected.push(threadSummary(thread, request.archived === true)); positions[provider].skip++;
  }
  // Normalize consumed pages without fetching a page the caller has not requested.
  for (const [provider, page] of pages) {
    const position = positions[provider];
    if (position.skip === page.data.length) {
      position.cursor = page.nextCursor ?? undefined; position.skip = 0; position.done = page.nextCursor === null; delete position.size;
    }
  }
  return { threads: selected, nextCursor: sources.providers.some(provider => !positions[provider].done) ? prefix + Buffer.from(JSON.stringify(positions)).toString("base64url") : null, backwardsCursor: null };
}
