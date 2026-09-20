import { expect, test } from "bun:test";
import { webHarness } from "./helpers/web_harness";
import { installWebSkills } from "./helpers/web_skills_harness";

test("web skills discover in the attached workspace, reload, and toggle exact paths through shared controls", async () => {
  const h = webHarness(); const fixture = installWebSkills(h);
  try {
    const c = await h.create(); const path = `/conversations/${c.id}/skills`;
    expect(await (await h.request(path)).json()).toEqual(fixture.data);
    expect(fixture.calls[0]).toEqual({ threadId: c.threadId, request: {} });
    expect((await h.request(`${path}-reload`, "POST", {})).status).toBe(200);
    expect(fixture.calls.at(-1)).toEqual({ threadId: c.threadId, request: { forceReload: true } });
    const skill = fixture.data.data[0]!.skills[1]!;
    expect(await (await h.request(path, "POST", { path: skill.path, enabled: true })).json()).toEqual({ effectiveEnabled: true });
    expect(fixture.calls.at(-1)).toEqual({ threadId: c.threadId, request: { path: skill.path, enabled: true } });
    expect(fixture.data.data[0]!.skills.every((skill) => skill.enabled)).toBe(true);
    Object.assign(h.application.conversation, { writeSkillConfig: async () => ({ effectiveEnabled: false }) });
    expect(await (await h.request(path, "POST", { path: skill.path, enabled: true })).json()).toEqual({ effectiveEnabled: false });
  } finally { h.api.dispose(); }
});

test("skill input, resolution errors, origin, and detached handles are handled without writes", async () => {
  const h = webHarness(); const fixture = installWebSkills(h);
  try {
    const c = await h.create(); const path = `/conversations/${c.id}/skills`;
    for (const body of [{ path: "review", enabled: "true" }, { path: "", enabled: false }, { path: "review", enabled: false, cwd: "/other" }, { path: "review" }]) expect((await h.request(path, "POST", body)).status).toBe(400);
    for (const [value, code] of [["review", "skill_ambiguous"], ["missing", "skill_not_found"]]) {
      const response = await h.request(path, "POST", { path: value, enabled: false });
      expect(response.status).toBe(400); expect((await response.json()).error.code).toBe(code);
    }
    expect((await h.request(`${path}-reload`, "POST", { cwds: ["/other"] })).status).toBe(400);
    expect((await h.request(path, "POST", { path: "review", enabled: false }, { origin: "https://evil.test" })).status).toBe(403);
    expect(fixture.calls.some((call) => "enabled" in call.request)).toBe(false);
    await h.request(`/conversations/${c.id}`, "DELETE");
    expect((await h.request(path)).status).toBe(404);
  } finally { h.api.dispose(); }
});

test("reload and skill writes use the conversation mutation lock and release it on failure", async () => {
  const h = webHarness(); installWebSkills(h);
  let release!: () => void;
  Object.assign(h.application.conversation, { listSkills: async () => { await new Promise<void>((resolve) => { release = resolve; }); throw new Error("private backend error"); } });
  try {
    const c = await h.create(); const path = `/conversations/${c.id}/skills`;
    const pending = h.request(`${path}-reload`, "POST", {});
    while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
    expect((await h.request(path, "POST", { path: "review", enabled: false })).status).toBe(409);
    release(); const response = await pending;
    expect(response.status).toBe(502); expect(await response.text()).not.toContain("private backend error");
    installWebSkills(h);
    expect((await h.request(`${path}-reload`, "POST", {})).status).toBe(200);
  } finally { release?.(); h.api.dispose(); }
});
