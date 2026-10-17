import { POLICY_PRESETS, type ExecutionPolicy, type PolicyPreset } from "../../shared/protocol/execution_policy.js";

const presets = [...Object.keys(POLICY_PRESETS), "provider_default"] as PolicyPreset[];

/** Host configuration is independent of any installed provider. `policy: null` leaves each agent's
 * own configured defaults. */
export function readProviderDefaults(env: Readonly<Record<string, string | undefined>>): {
  policy: ExecutionPolicy | null; defaultProvider?: string;
} {
  // Provider identities are opaque; composition validates that the selected identity is installed.
  const defaultProvider = env.SHEPHERD_DEFAULT_PROVIDER?.trim();
  for (const removed of ["SHEPHERD_APPROVAL_MODE", "SHEPHERD_SANDBOX_MODE"]) {
    if (env[removed]?.trim()) throw new Error(`${removed} was replaced by SHEPHERD_POLICY (${presets.join(", ")}); remove it and set SHEPHERD_POLICY instead.`);
  }
  const preset = (env.SHEPHERD_POLICY?.trim() || "provider_default") as PolicyPreset;
  if (!presets.includes(preset)) throw new Error(`SHEPHERD_POLICY must be one of ${presets.join(", ")}.`);
  return {
    policy: preset === "provider_default" ? null : { ...POLICY_PRESETS[preset] },
    ...(defaultProvider ? { defaultProvider } : {}),
  };
}
