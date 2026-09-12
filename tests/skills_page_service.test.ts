import { expect, test } from "bun:test";
import { loadSkillsPage, selectSkillsPage } from "../server/core/skills_page_service.js";
import type { SkillsListResponse } from "../shared/protocol/requests.js";

const inventory: SkillsListResponse = { data: [
  { cwd: "/one", skills: [{ name: "skill", description: "long ".repeat(1000), enabled: true, scope: "repo", path: "/skill" }], errors: [{ path: "/bad", message: "invalid" }] },
  { cwd: "/two", skills: [{ name: "other", description: "other", enabled: false, scope: "user", path: "/other" }], errors: [] },
] };

test("skill pages preserve complete metadata, cwd and error ordering with a custom size", () => {
  const first = selectSkillsPage(inventory, 1, 2);
  expect(first).toMatchObject({ page: 1, pageSize: 2, offset: 0, totalEntries: 3, previousPage: null, nextPage: 2 });
  expect(first.entries).toEqual([
    { kind: "skill", cwd: "/one", skill: inventory.data[0]!.skills[0] },
    { kind: "error", cwd: "/one", error: inventory.data[0]!.errors[0] },
  ]);
  const last = selectSkillsPage(inventory, 99, 2);
  expect(last).toMatchObject({ page: 2, offset: 2, previousPage: 1, nextPage: null });
  expect(last.entries[0]?.cwd).toBe("/two");
  expect(selectSkillsPage({ data: [] }, 3, 2)).toMatchObject({ page: 1, entries: [], nextPage: null });
});

test("skill loading scopes the inventory and preserves explicit reload", async () => {
  const requests: unknown[] = [];
  const source = { async listSkills(threadId: string, options: unknown) {
    requests.push({ threadId, options }); return inventory;
  } };
  await loadSkillsPage(source, { threadId: "thread", page: 1, pageSize: 2, forceReload: true });
  await loadSkillsPage(source, { threadId: "thread", page: 2, pageSize: 2 });
  expect(requests).toEqual([{ threadId: "thread", options: { forceReload: true } }, { threadId: "thread", options: {} }]);
});

test("invalid skill pagination fails explicitly", () => {
  for (const [page, size] of [[0, 5], [1, 0], [NaN, 5], [1, 1.5]]) {
    expect(() => selectSkillsPage(inventory, page!, size!)).toThrow("positive integers");
  }
});
