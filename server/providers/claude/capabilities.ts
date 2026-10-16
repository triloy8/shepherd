import type { ProviderCapabilities } from "../../../shared/protocol/provider_capabilities.js";

export const claudeCapabilities: ProviderCapabilities = Object.freeze({
  steer: true, interrupt: true, rename: true, archive: true, unarchive: true,
  workspaceChange: true, modelCatalog: true, modelCatalogScope: "provider", modelCatalogAuthoritative: true, modelSelection: true, effortSelection: true,
  skillConfig: false, questions: true, skills: false, compact: false, revert: false, fork: true, accountReset: false,
  sandboxModes: Object.freeze(["unrestricted"] as const),
  approvalModes: Object.freeze(["provider_default", "review_sensitive", "review_untrusted", "bypass"] as const),
  inputKinds: Object.freeze(["text", "image"] as const),
  imageDetail: false,
});
