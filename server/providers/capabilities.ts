import type { ProviderCapabilities } from "../../shared/protocol/provider_capabilities.js";

export const codexCapabilities: ProviderCapabilities = Object.freeze({
  questions: true, skills: true, compact: true, revert: true, fork: true,
  sandboxModes: Object.freeze(["read-only", "workspace-write", "danger-full-access"] as const),
});
export const claudeCapabilities: ProviderCapabilities = Object.freeze({
  questions: true, skills: false, compact: false, revert: false, fork: true,
  sandboxModes: Object.freeze(["danger-full-access"] as const),
});
