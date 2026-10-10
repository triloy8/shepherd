import type { ProviderCapabilities } from "./provider_capabilities.js";
export interface ProviderDescriptor { id: string; displayName: string; capabilities: ProviderCapabilities & { resets: boolean } }
