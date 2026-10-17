import type { ProviderCapabilities, ProviderOperation } from "./provider_capabilities.js";
import type { CreateThreadRequest, ThreadPolicy } from "./requests.js";
import { resolveProfile, type ExecutionPolicy } from "./execution_policy.js";
import type { UserInput } from "./user_input.js";

export class UnsupportedProviderOperationError extends Error {
  constructor(provider: string, operation: string) { super(`${provider} provider does not support ${operation}.`); }
}

/** Host-wide preferences. `policy: null` leaves each agent's own configured defaults. */
export type ThreadDefaults = { policy?: ExecutionPolicy | null };

/** The profile a thread runs with: the least restrictive one within the requested policy, or the
 * host policy when none is requested. Policy never loosens, so a provider without a profile within
 * it is refused. Null means no policy applies and the agent uses its own defaults. */
export function resolveThreadProfile(provider: string, capabilities: ProviderCapabilities, requested: ExecutionPolicy | undefined, hostPolicy: ExecutionPolicy | null | undefined): string | null {
  const limit = requested ?? hostPolicy ?? null;
  if (!limit) return null;
  const profile = resolveProfile(capabilities.policyProfiles, limit);
  if (!profile) throw new UnsupportedProviderOperationError(provider, `execution policy writes=${limit.writes}, network=${limit.network}, review=${limit.review} or a stricter one`);
  return profile.id;
}

/** A profile and the restrictions it guarantees, as thread state reports them. */
export function threadPolicy(capabilities: ProviderCapabilities, profile: string | null): ThreadPolicy {
  const declared = profile === null ? undefined : capabilities.policyProfiles.find(entry => entry.id === profile);
  return declared ? { profile: declared.id, policy: { ...declared.policy } } : null;
}

export function assertThreadSupport(provider: string, capabilities: ProviderCapabilities, request: Pick<CreateThreadRequest, "model" | "effort">): void {
  if (request.model) assertProviderOperation(provider, capabilities, "modelSelection");
  if (request.effort) assertProviderOperation(provider, capabilities, "effortSelection");
}

export function assertInputSupport(provider: string, capabilities: ProviderCapabilities, input: readonly UserInput[]): void {
  for (const part of input) {
    if (!capabilities.inputKinds.includes(part.type)) throw new UnsupportedProviderOperationError(provider, `${part.type} inputs`);
    if ((part.type === "image" || part.type === "image_file") && part.detail && !capabilities.imageDetail) throw new UnsupportedProviderOperationError(provider, "image detail overrides");
  }
}

export function assertProviderOperation(provider: string, capabilities: ProviderCapabilities, operation: ProviderOperation): void {
  if (!capabilities[operation]) throw new UnsupportedProviderOperationError(provider, operation);
}
