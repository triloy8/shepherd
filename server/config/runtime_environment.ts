import type { ApprovalPolicy, SandboxMode } from "../../shared/protocol/requests.js";
import { readApprovalPolicy } from "./environment.js";
import { readSignalRuntimeConfig, type SignalRuntimeConfig } from "./signal_environment.js";

export type RuntimeConfig = {
  approvalPolicy: ApprovalPolicy;
  defaultSandbox?: SandboxMode;
  deploymentCommandTimeoutMs?: number;
  signals: SignalRuntimeConfig;
};

export function readRuntimeConfig(environment: Record<string, string | undefined> = process.env): RuntimeConfig {
  const sandbox = environment.CODEX_SANDBOX;
  if (sandbox && !["read-only", "workspace-write", "danger-full-access"].includes(sandbox)) {
    throw new Error("Invalid CODEX_SANDBOX.");
  }
  const rawTimeout = environment.SHEPHERD_DEPLOY_COMMAND_TIMEOUT_MS;
  const timeout = rawTimeout ? Number(rawTimeout) : undefined;
  if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) {
    throw new Error("SHEPHERD_DEPLOY_COMMAND_TIMEOUT_MS must be a positive number.");
  }
  return {
    approvalPolicy: readApprovalPolicy(environment.CODEX_APPROVAL_POLICY),
    defaultSandbox: (sandbox || undefined) as SandboxMode | undefined,
    deploymentCommandTimeoutMs: timeout,
    signals: readSignalRuntimeConfig(environment),
  };
}
