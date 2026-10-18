import type { PolicyProfile } from "./execution_policy.js";
import type { UserInput } from "./user_input.js";
import type { TurnTrigger } from "./requests.js";

/** Adapter transport and operation support. Selected-model constraints live in ModelCapabilities. */
export interface ProviderCapabilities {
  /** Optional operations. False must be enforced even when an adapter has a method. */
  steer: boolean;
  interrupt: boolean;
  rename: boolean;
  archive: boolean;
  unarchive: boolean;
  workspaceChange: boolean;
  modelCatalog: boolean;
  /** Conversation catalogs become available after bootstrap; omitted means conversation-scoped. */
  modelCatalogScope?: "provider" | "conversation";
  /** True promises exhaustive selection IDs; otherwise discovery is advisory. */
  modelCatalogAuthoritative?: boolean;
  /** Selection and discovery are independent; adapters validate selections without a catalog. */
  modelSelection: boolean;
  effortSelection: boolean;
  skillConfig: boolean;
  questions: boolean;
  skills: boolean;
  compact: boolean;
  revert: boolean;
  fork: boolean;
  /** Redeeming account usage resets; the account reader must implement reset. */
  accountReset: boolean;
  /** Native execution modes and the restrictions each guarantees. Core picks the least
   * restrictive one within the requested policy. */
  policyProfiles: readonly PolicyProfile[];
  inputKinds: readonly UserInput["type"][];
  /** The turn triggers this provider reports. A provider that lists none leaves every turn
   * unmarked, which means unknown rather than started by a person. */
  turnTriggers?: readonly TurnTrigger[];
  imageDetail: boolean;
}

/** Boolean capabilities that describe data rather than an operation core can be asked to run. */
type CapabilityQualifier = "modelCatalogAuthoritative" | "imageDetail";

/** Operations that can be checked with assertProviderOperation. */
export type ProviderOperation = Exclude<{
  [K in keyof ProviderCapabilities]-?: ProviderCapabilities[K] extends boolean ? K : never
}[keyof ProviderCapabilities], CapabilityQualifier>;
