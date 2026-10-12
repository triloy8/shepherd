import type { ApprovalPolicy, SandboxMode } from "./requests.js";
import type { UserInput } from "./user_input.js";

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
  sandboxModes: readonly SandboxMode[];
  approvalModes: readonly ApprovalPolicy[];
  inputKinds: readonly UserInput["type"][];
  imageDetail: boolean;
  ephemeralThreads: boolean;
}

export type ProviderOperation = {
  [K in keyof ProviderCapabilities]-?: ProviderCapabilities[K] extends boolean ? K : never
}[keyof ProviderCapabilities];
