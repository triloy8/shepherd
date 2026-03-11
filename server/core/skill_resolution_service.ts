import type { SkillMetadata, SkillsListResponse } from "../../shared/protocol/requests.js";

export type ResolvedSkillPath =
  | { path: string }
  | { error: string };

function normalizeValue(value: string): string {
  return value.trim().toLowerCase();
}

function parseSkillLookups(value: SkillsListResponse): SkillMetadata[] {
  const lookups: SkillMetadata[] = [];
  for (const entry of value.data) {
    for (const skill of entry.skills) {
      lookups.push(skill);
    }
  }
  return lookups;
}

export function resolveSkillPathFromList(
  listed: SkillsListResponse,
  rawValue: string,
): ResolvedSkillPath {
  const value = rawValue.trim();
  if (!value) {
    return { error: "Invalid skill name or path." };
  }

  if (value.includes("/") || value.endsWith(".md")) {
    return { path: value };
  }

  const skills = parseSkillLookups(listed);
  const normalized = normalizeValue(value);

  const exactNameMatches = skills.filter((skill) => normalizeValue(skill.name) === normalized);
  if (exactNameMatches.length === 1) {
    return { path: exactNameMatches[0]!.path };
  }
  if (exactNameMatches.length > 1) {
    const options = exactNameMatches.map((skill) => `${skill.name} [${skill.scope}]`).join(", ");
    return { error: `Multiple skills match \`${value}\`: ${options}. Use the full path.` };
  }

  const qualifiedMatches = skills.filter(
    (skill) => normalizeValue(`${skill.name} [${skill.scope}]`) === normalized,
  );
  if (qualifiedMatches.length === 1) {
    return { path: qualifiedMatches[0]!.path };
  }

  return { error: `No loaded skill matches \`${value}\`. Use \`!skills\` to inspect available names.` };
}
