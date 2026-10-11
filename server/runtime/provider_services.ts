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

/** Provider identities and implementations meet only at production composition. */
export function createProviderServices(): ProviderServices {
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
  ], process.env.SHEPHERD_PROVIDER_STATE_DIR ?? join(homedir(), ".shepherd", "providers"));
}
