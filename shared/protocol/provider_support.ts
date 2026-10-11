import type { ProviderCapabilities } from "./provider_capabilities.js";
import type { ApprovalPolicy, CreateThreadRequest } from "./requests.js";
import type { UserInput } from "./user_input.js";

export class UnsupportedProviderOperationError extends Error {
  constructor(provider: string, operation: string) { super(`${provider} provider does not support ${operation}.`); }
}

export function assertApprovalSupport(provider: string, capabilities: ProviderCapabilities, policy: ApprovalPolicy): void {
  if (!capabilities.approvalModes.includes(policy)) throw new UnsupportedProviderOperationError(provider, `approval mode ${policy}`);
}

export function assertThreadSupport(provider: string, capabilities: ProviderCapabilities, request: Pick<CreateThreadRequest, "approvalPolicy" | "sandbox" | "ephemeral">): void {
  if (request.approvalPolicy) assertApprovalSupport(provider, capabilities, request.approvalPolicy);
  if (request.sandbox && !capabilities.sandboxModes.includes(request.sandbox)) throw new UnsupportedProviderOperationError(provider, `sandbox mode ${request.sandbox}`);
  if (request.ephemeral && !capabilities.ephemeralThreads) throw new UnsupportedProviderOperationError(provider, "ephemeral threads");
}

export function assertInputSupport(provider: string, capabilities: ProviderCapabilities, input: readonly UserInput[]): void {
  for (const part of input) {
    if (!capabilities.inputKinds.includes(part.type)) throw new UnsupportedProviderOperationError(provider, `${part.type} inputs`);
    if ((part.type === "image" || part.type === "image_file") && part.detail && !capabilities.imageDetail) throw new UnsupportedProviderOperationError(provider, "image detail overrides");
  }
}
