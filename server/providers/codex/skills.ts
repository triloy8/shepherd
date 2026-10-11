import type { SkillMetadata, SkillScope, SkillsConfigWriteResponse, SkillsListResponse } from "../../../shared/protocol/requests.js";
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string | null => typeof value === "string" ? value : null;

function skill(value: unknown): SkillMetadata | null {
  const native = record(value);
  const name = string(native.name), path = string(native.path), scope: SkillScope | null = string(native.scope);
  if (!name || !path || !scope || typeof native.enabled !== "boolean") return null;
  // Codex interface metadata (icons, brand colors, default prompts) and tool dependencies stay private.
  return { name, path, description: string(native.description) ?? "", scope, enabled: native.enabled };
}

export function codexSkills(value: unknown): SkillsListResponse {
  const data = record(value).data;
  if (!Array.isArray(data)) throw new Error("Invalid skills list.");
  return { data: data.map(raw => {
    const entry = record(raw);
    return {
      cwd: string(entry.cwd) ?? "",
      skills: (Array.isArray(entry.skills) ? entry.skills : []).flatMap(value => skill(value) ?? []),
      errors: (Array.isArray(entry.errors) ? entry.errors : []).map(raw => { const error = record(raw); return { path: string(error.path) ?? "", message: string(error.message) ?? "Skill could not be loaded." }; }),
    };
  }) };
}

export function codexSkillConfig(value: unknown): SkillsConfigWriteResponse {
  const effectiveEnabled = record(value).effectiveEnabled;
  if (typeof effectiveEnabled !== "boolean") throw new Error("Invalid skill configuration response.");
  return { effectiveEnabled };
}
