import type { SkillsListRequest, SkillsListResponse, SkillsConfigWriteRequest } from "../../shared/protocol/requests";
import type { webHarness } from "./web_harness";

export function installWebSkills(h: ReturnType<typeof webHarness>) {
  const data: SkillsListResponse = { data: [{ cwd: "/workspace", errors: [{ path: "/workspace/broken/SKILL.md", message: "Missing description" }], skills: [
    { name: "review", description: "Review project changes.", path: "/workspace/review/SKILL.md", scope: "repo", enabled: true },
    { name: "review", description: "Review personal notes.", path: "/user/review/SKILL.md", scope: "user", enabled: false },
  ] }] };
  const calls: Array<{ threadId: string; request: SkillsListRequest | SkillsConfigWriteRequest }> = [];
  Object.assign(h.application, { getSurfaceThreadId: (id: string) => h.bindings.get(id) ?? null });
  Object.assign(h.application.conversation, {
    async listSkills(threadId: string, request: SkillsListRequest) { calls.push({ threadId, request }); return structuredClone(data); },
    async writeSkillConfig(threadId: string, request: SkillsConfigWriteRequest) {
      calls.push({ threadId, request });
      const skill = data.data[0]!.skills.find((skill) => skill.path === request.path);
      if (!skill) throw new Error("Unknown fixture skill");
      skill.enabled = request.enabled;
      return { effectiveEnabled: skill.enabled };
    },
  });
  return { calls, data };
}
