import type { ApprovalPolicy, SandboxMode } from "./requests.js";
import type { UserInput } from "./user_input.js";

/** Adapter transport and operation support. Selected-model constraints live in ModelCapabilities. */
export interface ProviderCapabilities {
  questions: boolean;
  skills: boolean;
  compact: boolean;
  revert: boolean;
  fork: boolean;
  sandboxModes: readonly SandboxMode[];
  approvalModes: readonly ApprovalPolicy[];
  inputKinds: readonly UserInput["type"][];
  imageDetail: boolean;
  ephemeralThreads: boolean;
}
