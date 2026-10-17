import type { ProviderCapabilities } from "./provider_capabilities.js";
/** `isDefault` marks the agent used when a request names no provider. */
export interface ProviderDescriptor {
  id: string;
  displayName: string;
  isDefault: boolean;
  /** Whether an account reader is installed; absent means unknown for older clients. */
  accountReporting?: boolean;
  capabilities: ProviderCapabilities;
}
