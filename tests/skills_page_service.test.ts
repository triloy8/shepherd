import { expect, test } from "bun:test";
import { loadSkillsPage, selectSkillsPage } from "../server/adapters/shared/skills_page_service.js";
import type { SkillsListResponse } from "../shared/protocol/requests.js";

const inventory: SkillsListResponse = {
  workspacePath: "/one",
  skills: [
    { name: "skill", description: "long ".repeat(1000), enabled: true, scope: "repo", path: "/skill" },
    { name: "other", description: "other", enabled: false, scope: "user", path: "/other" },
  ],
  errors: [{ path: "/bad", message: "invalid" }],
};

test("skill pages preserve complete metadata, workspace and skill-then-error ordering with a custom size", () => {
  const first = selectSkillsPage(inventory, 1, 2);
  expect(first).toMatchObject({ workspacePath: "/one", page: 1, pageSize: 2, offset: 0, totalEntries: 3, previousPage: null, nextPage: 2 });
  expect(first.entries).toEqual([
    { kind: "skill", skill: inventory.skills[0] },
    { kind: "skill", skill: inventory.skills[1] },
  ]);
  const last = selectSkillsPage(inventory, 99, 2);
  expect(last).toMatchObject({ page: 2, offset: 2, previousPage: 1, nextPage: null });
  expect(last.entries).toEqual([{ kind: "error", error: inventory.errors[0] }]);
  expect(selectSkillsPage({ workspacePath: "/empty", skills: [], errors: [] }, 3, 2)).toMatchObject({ page: 1, entries: [], nextPage: null });
});

test("skill loading scopes the inventory and preserves explicit reload", async () => {
  const requests: unknown[] = [];
  const source = { async listSkills(threadId: string, options: unknown) {
    requests.push({ threadId, options }); return inventory;
  } };
  await loadSkillsPage(source, { threadId: "thread", page: 1, pageSize: 2, refresh: true });
  await loadSkillsPage(source, { threadId: "thread", page: 2, pageSize: 2 });
  expect(requests).toEqual([{ threadId: "thread", options: { refresh: true } }, { threadId: "thread", options: {} }]);
});

test("invalid skill pagination fails explicitly", () => {
  for (const [page, size] of [[0, 5], [1, 0], [NaN, 5], [1, 1.5]]) {
    expect(() => selectSkillsPage(inventory, page!, size!)).toThrow("positive integers");
  }
});
