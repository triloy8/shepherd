import { claudeProfiles } from "./permissions.js";
import type { ProviderCapabilities } from "../../../shared/protocol/provider_capabilities.js";

export const claudeCapabilities: ProviderCapabilities = Object.freeze({
  steer: true, interrupt: true, rename: true, archive: true, unarchive: true,
  workspaceChange: true, modelCatalog: true, modelCatalogScope: "provider", modelCatalogAuthoritative: true, modelSelection: true, effortSelection: true,
  skillConfig: false, questions: true, skills: false, compact: false, revert: false, fork: true, accountReset: false,
  policyProfiles: claudeProfiles,
  inputKinds: Object.freeze(["text", "image"] as const),
  imageDetail: false,
});
