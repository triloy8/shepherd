import type { ListModelsRequest, ListModelsResponse, ModelSummary } from "../../../shared/protocol/requests.js";

/** Resolve an exact model ID or the default across a provider's catalog pages. */
export async function findListedModel(
  listModels: (request: ListModelsRequest) => Promise<ListModelsResponse>,
  scope: Pick<ListModelsRequest, "provider" | "threadId">,
  model?: string | null,
): Promise<ModelSummary | null> {
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page = await listModels({ ...scope, cursor, limit: 100, includeHidden: true });
    const entry = page.data.find(candidate => model == null ? candidate.isDefault : candidate.id === model);
    if (entry) return entry;
    if (!page.nextCursor || seen.has(page.nextCursor)) return null;
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  } while (true);
}
