import type { ProviderCapabilities } from "../../../shared/protocol/provider_capabilities.js";

export const claudeCapabilities: ProviderCapabilities = Object.freeze({
  questions: true, skills: false, compact: false, revert: false, fork: true,
  sandboxModes: Object.freeze(["unrestricted"] as const),
  approvalModes: Object.freeze(["provider_default", "review_sensitive", "bypass"] as const),
  inputKinds: Object.freeze(["text", "image"] as const),
  textAnnotations: false, imageDetail: false, ephemeralThreads: false,
});
