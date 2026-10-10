import type { SandboxMode } from "./requests.js";

/** Operations offered by Shepherd. Model-specific controls belong to the catalog. */
export interface ProviderCapabilities {
  questions: boolean;
  skills: boolean;
  compact: boolean;
  revert: boolean;
  fork: boolean;
  sandboxModes: readonly SandboxMode[];
}
