import { expect, test } from "bun:test";
import { buildSkillsListPage, decodeDiscordListPageId } from "../server/adapters/discord/list_pagination.js";
import { handleInteraction } from "../server/adapters/discord/interactions.js";
import type { SkillsListResponse } from "../shared/protocol/requests.js";

function inventory(count: number): SkillsListResponse {
  return { data: [{
    cwd: "/repo",
    errors: [],
    skills: Array.from({ length: count }, (_, i) => ({
      name: `skill${i + 1}`, description: "A useful skill", enabled: i % 2 === 0,
      path: `/skills/${i + 1}/SKILL.md`, scope: "workspace",
    })),
  }] };
}

function json(page: unknown): any {
  return JSON.parse(JSON.stringify(page));
}

function button(page: unknown, label: string): any {
  return json(page).components[0].components
    .flatMap((component: any) => component.components ?? [])
    .find((component: any) => component.label === label);
}

test("skills navigate forward, backward and first using the shared buttons", async () => {
  const result = inventory(12);
  let page: unknown = buildSkillsListPage({ result, requesterId: "user-1", page: 1 });
  expect(button(page, "Previous").disabled).toBe(true);
  expect(button(page, "First").disabled).toBe(true);
  expect(JSON.stringify(page)).not.toContain("skill6");

  for (const [label, firstSkill] of [["Next", 6], ["Next", 11], ["Previous", 6], ["First", 1]] as const) {
    const customId = button(page, label).custom_id;
    expect(decodeDiscordListPageId(customId)?.target).toBe("skills");
    let deferred = false;
    await handleInteraction({
      customId, user: { id: "user-1" }, channelId: "channel-1",
      async deferUpdate() { deferred = true; },
      async editReply(payload: unknown) { page = payload; },
    } as never, {
      async listSkills(threadId: string, request: unknown) {
        expect(deferred).toBe(true);
        expect(threadId).toBe("thread-1");
        expect(request).toEqual({});
        return result;
      },
    } as never, { getSurfaceThreadId: () => "thread-1" });
    expect(JSON.stringify(page)).toContain(`${firstSkill}. skill${firstSkill}`);
    if (firstSkill === 11) expect(button(page, "Next").disabled).toBe(true);
  }
});

test("skills clamp stale pages and keep empty lists and discovery errors visible", () => {
  const empty = buildSkillsListPage({ result: inventory(0), requesterId: "user-1", page: 5 });
  expect(JSON.stringify(empty)).toContain("No skills found.");
  expect(button(empty, "Page 1").disabled).toBe(true);
  expect(button(empty, "Next").disabled).toBe(true);
  const result = inventory(5);
  result.data.push({ cwd: "/other", skills: [], errors: [{ path: "/bad/SKILL.md", message: "Invalid skill" }] });
  const errors = buildSkillsListPage({ result, requesterId: "user-1", page: 9 });
  expect(JSON.stringify(errors)).toContain("Skill discovery error");
  expect(JSON.stringify(errors)).toContain("Invalid skill");
  expect(JSON.stringify(errors)).toContain("/other");
  expect(button(errors, "Page 2").disabled).toBe(true);
});

test("long descriptions fit all five skills and navigation in one card", () => {
  const result = inventory(5);
  for (const skill of result.data[0]!.skills) skill.description = "long description ".repeat(1000);
  const page = buildSkillsListPage({ result, requesterId: "user-1", page: 1 });
  expect(JSON.stringify(page)).toContain("5. skill5");
  expect(JSON.stringify(page).length).toBeLessThan(4000);
  expect(button(page, "Next").disabled).toBe(true);
});

test("skills pagination reports a missing active thread without replacing the list", async () => {
  const result = inventory(6);
  const page = buildSkillsListPage({ result, requesterId: "user-1", page: 1 });
  let error: unknown;
  await handleInteraction({
    customId: button(page, "Next").custom_id,
    user: { id: "user-1" }, channelId: "channel-1",
    async deferUpdate() {},
    async followUp(payload: unknown) { error = payload; },
  } as never, {} as never, { getSurfaceThreadId: () => null });
  expect(JSON.stringify(error)).toContain("No active thread");
});
