import type { SkillErrorInfo, SkillMetadata, SkillsListRequest, SkillsListResponse } from "../../shared/protocol/requests.js";

export type SkillsPageEntry =
  | { kind: "skill"; skill: SkillMetadata }
  | { kind: "error"; error: SkillErrorInfo };

export interface SkillsPage {
  workspacePath: string;
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
  const entries: SkillsPageEntry[] = [
    ...result.skills.map((skill): SkillsPageEntry => ({ kind: "skill", skill })),
    ...result.errors.map((error): SkillsPageEntry => ({ kind: "error", error })),
  ];
  const lastPage = Math.max(1, Math.ceil(entries.length / pageSize));
  const selected = Math.min(page, lastPage);
  const offset = (selected - 1) * pageSize;
  return {
    workspacePath: result.workspacePath,
    entries: entries.slice(offset, offset + pageSize),
    page: selected, pageSize, offset, totalEntries: entries.length,
    previousPage: selected > 1 ? selected - 1 : null,
    nextPage: selected < lastPage ? selected + 1 : null,
  };
}

export async function loadSkillsPage(
  source: { listSkills(threadId: string, request: SkillsListRequest): Promise<SkillsListResponse> },
  request: { threadId: string; page: number; pageSize: number; refresh?: boolean },
): Promise<SkillsPage> {
  const result = await source.listSkills(request.threadId,
    request.refresh === undefined ? {} : { refresh: request.refresh });
  return selectSkillsPage(result, request.page, request.pageSize);
}
