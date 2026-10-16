/** What an agent may do in a thread, as three independent restrictions. Each is ordered from
 * strictest to loosest. */
export interface ExecutionPolicy {
  /** Where the agent may change files: nowhere, inside its workspace, or anywhere. */
  writes: "none" | "workspace" | "any";
  /** Whether the agent may use the network. */
  network: "none" | "any";
  /** Whether risky actions wait for a person's approval. */
  review: "risky" | "none";
}

/** One of a provider's native execution modes and the restrictions it guarantees. The ID is
 * opaque to core; adapters map it to their native settings. */
export interface PolicyProfile {
  id: string;
  label: string;
  policy: ExecutionPolicy;
}

/** Host presets for `SHEPHERD_POLICY`. `provider_default` applies no policy: each agent uses its
 * own configured defaults. */
export const POLICY_PRESETS = {
  bypass: { writes: "any", network: "any", review: "none" },
  review: { writes: "any", network: "any", review: "risky" },
  workspace: { writes: "workspace", network: "any", review: "risky" },
  read_only: { writes: "none", network: "any", review: "risky" },
} as const satisfies Record<string, ExecutionPolicy>;
export type PolicyPreset = keyof typeof POLICY_PRESETS | "provider_default";

const order = {
  writes: ["none", "workspace", "any"],
  network: ["none", "any"],
  review: ["risky", "none"],
} as const;
const facets = Object.keys(order) as Array<keyof ExecutionPolicy>;
const rank = (facet: keyof ExecutionPolicy, value: string) => (order[facet] as readonly string[]).indexOf(value);

/** Whether `candidate` is no looser than `limit` on every restriction. */
export function withinPolicy(candidate: ExecutionPolicy, limit: ExecutionPolicy): boolean {
  return facets.every(facet => rank(facet, candidate[facet]) <= rank(facet, limit[facet]));
}

/** The least restrictive profile that stays within `limit`, or null when every profile is
 * looser. Policy never loosens: a provider without an equal or stricter mode is refused. Among
 * equally loose profiles the first declared wins. */
export function resolveProfile(profiles: readonly PolicyProfile[], limit: ExecutionPolicy): PolicyProfile | null {
  const allowed = profiles.filter(profile => withinPolicy(profile.policy, limit));
  return allowed.reduce<PolicyProfile | null>((best, profile) => !best || (withinPolicy(best.policy, profile.policy) && !withinPolicy(profile.policy, best.policy)) ? profile : best, null);
}

export function isExecutionPolicy(value: unknown): value is ExecutionPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === facets.length && facets.every(facet => typeof record[facet] === "string" && rank(facet, record[facet] as string) >= 0);
}
