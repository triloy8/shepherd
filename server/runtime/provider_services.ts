import { CodexAccount } from "../providers/codex/account.js";
import { codexOwnsStoredThread } from "../providers/codex/thread_ownership.js";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderServices } from "../ports/provider_services.js";
import { CodexSession } from "../providers/codex/session.js";
import { ClaudeSession } from "../providers/claude/session.js";
import { codexCapabilities } from "../providers/codex/capabilities.js";
import { claudeCapabilities } from "../providers/claude/capabilities.js";
import { ClaudeAccountLimits } from "../providers/claude/account_limits.js";
import { ClaudeThreadStore } from "../providers/claude/file_thread_store.js";
import { ClaudeModelCache } from "../providers/claude/model_cache.js";
import { assembleProviderServices, describeThreadDefaults, type ProviderRegistration } from "./provider_registration.js";
import { resolveThreadDefaults, type ThreadDefaults } from "../../shared/protocol/provider_support.js";

/** One source for installed identities, configuration checks and runtime registrations.
 * Reading metadata never starts clients or opens provider storage. */
const installedDefinitions = [
  {
    id: "codex", displayName: "Codex", capabilities: codexCapabilities,
    register() {
      const account = new CodexAccount();
      return {
        create: (policy, tools) => new CodexSession(policy, tools),
        account, hasStoredThreads: () => true,
        ownsStoredThread: id => codexOwnsStoredThread(id),
        shutdown: () => account.stop(),
      } satisfies Omit<ProviderRegistration, "id" | "displayName" | "capabilities">;
    },
  },
  {
    id: "claude", displayName: "Claude", capabilities: claudeCapabilities,
    register() {
      const store = new ClaudeThreadStore();
      const limits = new ClaudeAccountLimits();
      const models = new ClaudeModelCache();
      return {
        create: (policy, tools) => new ClaudeSession(policy, tools, store, undefined, limits, models),
        account: { read: refresh => limits.readAccount(refresh) },
        hasStoredThreads: () => store.hasThreads(),
        ownsStoredThread: id => store.list().some(thread => thread.id === id),
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
  const refused = Object.entries(resolveThreadDefaults(defaults, definition.capabilities)).filter(([, resolution]) => resolution.outcome === "refuse");
  if (refused.length) throw new Error(describeThreadDefaults(defaults, [definition]).filter(notice => notice.includes("refuses")).join("\n"));
}

export function createProviderServices(defaultProvider: string = fallbackDefaultProvider): ProviderServices {
  assertInstalledProvider(defaultProvider);
  return assembleProviderServices(installedDefinitions.map(({ register, ...definition }) => ({ ...definition, ...register(), threadIdentity: "application" as const })),
    process.env.SHEPHERD_PROVIDER_STATE_DIR ?? join(homedir(), ".shepherd", "providers"), defaultProvider);
}
