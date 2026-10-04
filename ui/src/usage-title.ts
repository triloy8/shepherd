import type { ModelSummary } from "../../shared/protocol/requests";

const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;
export function humanizeUsageId(value: string): string {
  const label = value.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return label ? label[0]!.toUpperCase() + label.slice(1) : "Usage allowance";
}
export function usageTitle(id: string, value: unknown, models: ModelSummary[]): { title: string; subtitle: string | null } {
  const bucket = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const slug = text(bucket.normalModelSlug);
  const model = slug ? models.find((model) => model.model === slug || model.id === slug) : undefined;
  const display = text(model?.displayName);
  const label = text(bucket.limitName);
  // Provider display labels preserve punctuation/casing. Only opaque IDs are humanized.
  return { title: display ?? label ?? humanizeUsageId(id), subtitle: display && label && label !== display ? label : null };
}
