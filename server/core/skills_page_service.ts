import type { SkillErrorInfo, SkillMetadata, SkillsListRequest, SkillsListResponse } from "../../shared/protocol/requests.js";

export type SkillsPageEntry =
  | { kind: "skill"; cwd: string; skill: SkillMetadata }
  | { kind: "error"; cwd: string; error: SkillErrorInfo };

export interface SkillsPage {
  entries: SkillsPageEntry[];
  page: number;
  pageSize: number;
  offset: number;
  totalEntries: number;
  previousPage: number | null;
  nextPage: number | null;
}

export function selectSkillsPage(result: SkillsListResponse, page: number, pageSize: number): SkillsPage {
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1) {
    throw new Error("Page and page size must be positive integers.");
  }
  const entries = result.data.flatMap((entry): SkillsPageEntry[] => [
    ...entry.skills.map((skill): SkillsPageEntry => ({ kind: "skill", cwd: entry.cwd, skill })),
    ...entry.errors.map((error): SkillsPageEntry => ({ kind: "error", cwd: entry.cwd, error })),
  ]);
  const lastPage = Math.max(1, Math.ceil(entries.length / pageSize));
  const selected = Math.min(page, lastPage);
  const offset = (selected - 1) * pageSize;
  return {
    entries: entries.slice(offset, offset + pageSize),
    page: selected, pageSize, offset, totalEntries: entries.length,
    previousPage: selected > 1 ? selected - 1 : null,
    nextPage: selected < lastPage ? selected + 1 : null,
  };
}

export async function loadSkillsPage(
  source: { listSkills(threadId: string, request: SkillsListRequest): Promise<SkillsListResponse> },
  request: { threadId: string; page: number; pageSize: number; forceReload?: boolean },
): Promise<SkillsPage> {
  const result = await source.listSkills(request.threadId,
    request.forceReload === undefined ? {} : { forceReload: request.forceReload });
  return selectSkillsPage(result, request.page, request.pageSize);
}
