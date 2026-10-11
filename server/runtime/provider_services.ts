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
import { assembleProviderServices } from "./provider_registration.js";

/** Installed adapters. Provider identities and implementations meet only at production composition. */
export const installedProviders = ["codex", "claude"] as const;
const fallbackDefaultProvider = "codex";

export function assertInstalledProvider(id: string): void {
  if (!(installedProviders as readonly string[]).includes(id)) throw new Error(`SHEPHERD_DEFAULT_PROVIDER must be one of ${installedProviders.join(", ")}.`);
}

export function createProviderServices(defaultProvider: string = fallbackDefaultProvider): ProviderServices {
  assertInstalledProvider(defaultProvider);
  const store = new ClaudeThreadStore();
  const claudeLimits = new ClaudeAccountLimits();
  const codexAccount = new CodexAccount();
  return assembleProviderServices([
    {
      id: "codex", displayName: "Codex", capabilities: codexCapabilities,
      create: (policy, tools) => new CodexSession(policy, tools),
      account: codexAccount, hasStoredThreads: () => true,
      ownsStoredThread: id => codexOwnsStoredThread(id),
      shutdown: () => codexAccount.stop(),
    },
    {
      id: "claude", displayName: "Claude", capabilities: claudeCapabilities,
      create: (policy, tools) => new ClaudeSession(policy, tools, store, undefined, claudeLimits),
      account: { read: refresh => claudeLimits.readAccount(refresh) },
      hasStoredThreads: () => store.hasThreads(),
      ownsStoredThread: id => store.list().some(thread => thread.id === id),
      shutdown: () => claudeLimits.stop(),
    },
  ], process.env.SHEPHERD_PROVIDER_STATE_DIR ?? join(homedir(), ".shepherd", "providers"), defaultProvider);
}
