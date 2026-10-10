import { readProviderDefaults } from "../runtime/provider_defaults.js";
import type { ApprovalPolicy, SandboxMode } from "../../shared/protocol/requests.js";
import { readSignalRuntimeConfig, type SignalRuntimeConfig } from "./signal_environment.js";

export type RuntimeConfig = {
  approvalPolicy: ApprovalPolicy;
  defaultSandbox?: SandboxMode;
  deploymentCommandTimeoutMs?: number;
  signals: SignalRuntimeConfig;
};

export function readRuntimeConfig(environment: Record<string, string | undefined> = process.env): RuntimeConfig {
  const defaults = readProviderDefaults(environment);
  const rawTimeout = environment.SHEPHERD_DEPLOY_COMMAND_TIMEOUT_MS;
  const timeout = rawTimeout ? Number(rawTimeout) : undefined;
  if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) {
    throw new Error("SHEPHERD_DEPLOY_COMMAND_TIMEOUT_MS must be a positive number.");
  }
  return {
    approvalPolicy: defaults.approvalMode === "bypass" ? "never" : defaults.approvalMode === "review_all" ? "untrusted" : "on-request",
    defaultSandbox: defaults.sandboxMode === "read_only" ? "read-only" : defaults.sandboxMode === "workspace_write" ? "workspace-write" : defaults.sandboxMode === "unrestricted" ? "danger-full-access" : undefined,
    deploymentCommandTimeoutMs: timeout,
    signals: readSignalRuntimeConfig(environment),
  };
}
