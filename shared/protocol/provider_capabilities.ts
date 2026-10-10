import type { ApprovalPolicy, SandboxMode } from "./requests.js";
import type { UserInput } from "./user_input.js";

/** Support is advertised before a request is sent; unsupported settings never silently degrade. */
export interface ProviderCapabilities {
  questions: boolean;
  skills: boolean;
  compact: boolean;
  revert: boolean;
  fork: boolean;
  sandboxModes: readonly SandboxMode[];
  approvalModes: readonly ApprovalPolicy[];
  inputKinds: readonly UserInput["type"][];
  textAnnotations: boolean;
  imageDetail: boolean;
  ephemeralThreads: boolean;
}
