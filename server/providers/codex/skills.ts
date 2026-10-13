import type { SkillErrorInfo, SkillMetadata, SkillScope, SkillsConfigWriteResponse, SkillsListing } from "../../../shared/protocol/requests.js";
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string | null => typeof value === "string" ? value : null;

function skill(value: unknown): SkillMetadata | null {
  const native = record(value);
  const name = string(native.name), path = string(native.path), scope: SkillScope | null = string(native.scope);
  if (!name || !path || !scope || typeof native.enabled !== "boolean") return null;
  // Codex interface metadata (icons, brand colors, default prompts) and tool dependencies stay private.
  return { name, path, description: string(native.description) ?? "", scope, enabled: native.enabled };
}

/** Codex groups discovery by requested directory. Shepherd requests one workspace, so entries are merged. */
export function codexSkills(value: unknown): SkillsListing {
  const data = record(value).data;
  if (!Array.isArray(data)) throw new Error("Invalid skills list.");
  const skills = new Map<string, SkillMetadata>();
  const errors: SkillErrorInfo[] = [];
  for (const raw of data) {
    const entry = record(raw);
    for (const value of Array.isArray(entry.skills) ? entry.skills : []) {
      const decoded = skill(value);
      if (decoded && !skills.has(decoded.path)) skills.set(decoded.path, decoded);
    }
    for (const raw of Array.isArray(entry.errors) ? entry.errors : []) {
      const error = record(raw);
      errors.push({ path: string(error.path) ?? "", message: string(error.message) ?? "Skill could not be loaded." });
    }
  }
  return { skills: [...skills.values()], errors };
}

export function codexSkillConfig(value: unknown): SkillsConfigWriteResponse {
  const effectiveEnabled = record(value).effectiveEnabled;
  if (typeof effectiveEnabled !== "boolean") throw new Error("Invalid skill configuration response.");
  return { enabled: effectiveEnabled };
}
