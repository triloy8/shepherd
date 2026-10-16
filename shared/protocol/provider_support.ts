import type { ProviderCapabilities, ProviderOperation } from "./provider_capabilities.js";
import type { ApprovalPolicy, CreateThreadRequest, SandboxMode } from "./requests.js";
import type { UserInput } from "./user_input.js";

export class UnsupportedProviderOperationError extends Error {
  constructor(provider: string, operation: string) { super(`${provider} provider does not support ${operation}.`); }
}

/** Host-wide preferences. Unlike request values, they apply only where the thread's provider supports them. */
export type ThreadDefaults = { approvalPolicy?: ApprovalPolicy; sandbox?: SandboxMode };

/** Most restrictive first. `provider_default` has no known position, so it is never substituted. */
const approvalStrictness: readonly ApprovalPolicy[] = ["review_untrusted", "review_sensitive", "bypass"];
const sandboxStrictness: readonly SandboxMode[] = ["read_only", "workspace_write", "unrestricted"];

/** How a provider honors one host default: the configured mode, a stricter supported mode,
 * its own default (only when the configured mode is the least restrictive), or refusal. */
export type ThreadDefaultResolution<T> =
  | { outcome: "apply"; value: T }
  | { outcome: "stricter"; value: T }
  | { outcome: "provider_default" }
  | { outcome: "refuse" };

function resolveDefault<T>(configured: T, supported: readonly T[], strictness: readonly T[]): ThreadDefaultResolution<T> {
  if (supported.includes(configured)) return { outcome: "apply", value: configured };
  const rank = strictness.indexOf(configured);
  if (rank < 0) return { outcome: "provider_default" };
  // Prefer the least restrictive mode that is still no looser than the configured one.
  const stricter = strictness.slice(0, rank).reverse().find(mode => supported.includes(mode));
  if (stricter !== undefined) return { outcome: "stricter", value: stricter };
  // The provider's own default cannot be looser than the least restrictive mode.
  return rank === strictness.length - 1 ? { outcome: "provider_default" } : { outcome: "refuse" };
}

/** Host defaults never loosen execution. Configured defaults resolve per provider. */
export function resolveThreadDefaults(defaults: ThreadDefaults, capabilities: ProviderCapabilities): {
  approvalPolicy?: ThreadDefaultResolution<ApprovalPolicy>; sandbox?: ThreadDefaultResolution<SandboxMode>;
} {
  return {
    ...(defaults.approvalPolicy ? { approvalPolicy: resolveDefault(defaults.approvalPolicy, capabilities.approvalModes, approvalStrictness) } : {}),
    ...(defaults.sandbox ? { sandbox: resolveDefault(defaults.sandbox, capabilities.sandboxModes, sandboxStrictness) } : {}),
  };
}

export function assertApprovalSupport(provider: string, capabilities: ProviderCapabilities, policy: ApprovalPolicy): void {
  if (!capabilities.approvalModes.includes(policy)) throw new UnsupportedProviderOperationError(provider, `approval mode ${policy}`);
}

export function assertThreadSupport(provider: string, capabilities: ProviderCapabilities, request: Pick<CreateThreadRequest, "approvalPolicy" | "sandbox" | "model" | "effort">): void {
  if (request.model) assertProviderOperation(provider, capabilities, "modelSelection");
  if (request.effort) assertProviderOperation(provider, capabilities, "effortSelection");
  if (request.approvalPolicy) assertApprovalSupport(provider, capabilities, request.approvalPolicy);
  if (request.sandbox && !capabilities.sandboxModes.includes(request.sandbox)) throw new UnsupportedProviderOperationError(provider, `sandbox mode ${request.sandbox}`);
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
