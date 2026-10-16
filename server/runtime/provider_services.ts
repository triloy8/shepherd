import { CodexAccount } from "../providers/codex/account.js";
import { CodexAppServer } from "../providers/codex/app_server.js";
import { CodexSession } from "../providers/codex/session.js";
import { noProviderTools } from "../ports/provider_tools.js";
import { codexOwnsStoredThread } from "../providers/codex/thread_ownership.js";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderServices } from "../ports/provider_services.js";
import { CodexProvider } from "../providers/codex/provider.js";
import { ClaudeProvider } from "../providers/claude/provider.js";
import { codexCapabilities } from "../providers/codex/capabilities.js";
import { claudeCapabilities } from "../providers/claude/capabilities.js";
import { ClaudeAccountLimits } from "../providers/claude/account_limits.js";
import { claudeHasSessions, claudeNative, claudeSessionExists } from "../providers/claude/native_sessions.js";
import { ClaudeModelCache } from "../providers/claude/model_cache.js";
import { assembleProviderServices, describeThreadDefaults, type ProviderRegistration } from "./provider_registration.js";
import type { ThreadDefaults } from "../../shared/protocol/provider_support.js";
import { resolveProfile } from "../../shared/protocol/execution_policy.js";

/** One source for installed identities, configuration checks and runtime registrations.
 * Reading metadata never starts clients or opens provider storage. */
const installedDefinitions = [
  {
    id: "codex", displayName: "Codex", capabilities: codexCapabilities,
    register() {
      // Conversations, history and the account share one app-server process.
      const server = new CodexAppServer();
      const account = new CodexAccount(() => new CodexSession(noProviderTools, undefined, server));
      return {
        provider: new CodexProvider(undefined, server),
        account, hasStoredThreads: () => true,
        ownsStoredThread: id => codexOwnsStoredThread(id),
        shutdown: () => account.stop(),
      } satisfies Omit<ProviderRegistration, "id" | "displayName" | "capabilities">;
    },
  },
  {
    id: "claude", displayName: "Claude", capabilities: claudeCapabilities,
    register() {
      const limits = new ClaudeAccountLimits();
      const models = new ClaudeModelCache();
      return {
        provider: new ClaudeProvider(claudeNative, limits, models),
        account: { read: refresh => limits.readAccount(refresh) },
        hasStoredThreads: () => claudeHasSessions(),
        ownsStoredThread: id => claudeSessionExists(id),
        shutdown: () => limits.stop(),
      } satisfies Omit<ProviderRegistration, "id" | "displayName" | "capabilities">;
    },
  },
];

export const installedProviders = installedDefinitions.map(definition => definition.id);
const fallbackDefaultProvider = "codex";

export function assertInstalledProvider(id: string): void {
  if (!installedProviders.includes(id)) throw new Error(`SHEPHERD_DEFAULT_PROVIDER must be one of ${installedProviders.join(", ")}.`);
}

export function threadDefaultNotices(defaults: ThreadDefaults): string[] {
  return describeThreadDefaults(defaults, installedDefinitions);
}

/** Every new conversation without a named agent would be refused, so this is a configuration error. */
export function assertDefaultProviderAcceptsThreadDefaults(defaults: ThreadDefaults, defaultProvider: string = fallbackDefaultProvider): void {
  assertInstalledProvider(defaultProvider);
  const definition = installedDefinitions.find(entry => entry.id === defaultProvider)!;
  if (defaults.policy && !resolveProfile(definition.capabilities.policyProfiles, defaults.policy)) throw new Error(describeThreadDefaults(defaults, [definition]).join("\n"));
}

export function createProviderServices(defaultProvider: string = fallbackDefaultProvider): ProviderServices {
  assertInstalledProvider(defaultProvider);
  return assembleProviderServices(installedDefinitions.map(({ register, ...definition }) => ({ ...definition, ...register(), threadIdentity: "application" as const })),
    process.env.SHEPHERD_PROVIDER_STATE_DIR ?? join(homedir(), ".shepherd", "providers"), defaultProvider);
}
