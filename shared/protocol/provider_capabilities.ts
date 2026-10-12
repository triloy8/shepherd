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
  /** Selection requires modelCatalog; a catalog can also be read-only. */
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
  [K in keyof ProviderCapabilities]: ProviderCapabilities[K] extends boolean ? K : never
}[keyof ProviderCapabilities];
