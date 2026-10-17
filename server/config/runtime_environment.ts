import { readProviderDefaults } from "../runtime/provider_defaults.js";
import type { ExecutionPolicy } from "../../shared/protocol/execution_policy.js";
import { readSignalRuntimeConfig, type SignalRuntimeConfig } from "./signal_environment.js";

export type RuntimeConfig = {
  /** The host execution policy; null leaves each agent's own defaults. */
  policy: ExecutionPolicy | null;
  defaultProvider?: string;
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
    policy: defaults.policy,
    ...(defaults.defaultProvider ? { defaultProvider: defaults.defaultProvider } : {}),
    deploymentCommandTimeoutMs: timeout,
    signals: readSignalRuntimeConfig(environment),
  };
}
