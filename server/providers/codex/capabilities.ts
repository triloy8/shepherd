import { codexProfiles } from "./policy.js";
import type { ProviderCapabilities } from "../../../shared/protocol/provider_capabilities.js";

export const codexCapabilities: ProviderCapabilities = Object.freeze({
  steer: true, interrupt: true, rename: true, archive: true, unarchive: true,
  workspaceChange: true, modelCatalog: true, modelCatalogScope: "provider", modelCatalogAuthoritative: true, modelSelection: true, effortSelection: true,
  skillConfig: true, questions: true, skills: true, compact: true, revert: true, fork: true, accountReset: true,
  policyProfiles: codexProfiles,
  inputKinds: Object.freeze(["text", "image", "image_file", "audio", "audio_file", "skill"] as const),
  imageDetail: true,
});
