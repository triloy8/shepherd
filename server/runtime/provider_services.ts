import { DynamicToolRegistry } from "../core/dynamic_tool_registry.js";
import { CodexAccount } from "../providers/codex/account.js";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderServices } from "../ports/provider_services.js";
import { CodexSession } from "../providers/codex/session.js";
import { ClaudeSession } from "../providers/claude/session.js";
import { ClaudeAccountLimits } from "../providers/claude/account_limits.js";
import { ClaudeThreadStore } from "../storage/claude_thread_store.js";
import { FileThreadProviderDirectory } from "../storage/thread_provider_directory.js";

/** The only production assembly point for application and native provider layers. */
export function createProviderServices(): ProviderServices {
  const store = new ClaudeThreadStore();
  const claudeLimits = new ClaudeAccountLimits();
  const factories = new Map<string, { displayName: string; create: ProviderServices["createSession"]; stored: () => boolean }>([
    ["codex", { displayName: "Codex", create: (policy, tools) => new CodexSession(policy, tools), stored: () => false }],
    ["claude", { displayName: "Claude", create: (policy, tools) => new ClaudeSession(policy, tools, store, undefined, claudeLimits), stored: () => store.hasThreads() }],
  ]);
  const descriptors = [...factories].map(([id, factory]) => {
    const preview = factory.create("on-request", new DynamicToolRegistry(), id);
    const capabilities = { ...preview.capabilities, resets: false }; preview.stop();
    return { id, displayName: factory.displayName, capabilities };
  });
  const codexAccount = new CodexAccount();
  const accounts: ProviderServices["accounts"] = new Map<string, import("../ports/provider_services.js").ProviderAccount>([
    ["codex", codexAccount],
    ["claude", { read: (refresh?: boolean) => claudeLimits.readAccount(refresh) }],
  ]);
  for (const descriptor of descriptors) descriptor.capabilities.resets = !!accounts.get(descriptor.id)?.reset;
  return {
    descriptors, accounts,
    shutdown: () => { codexAccount.stop(); claudeLimits.stop(); },
    providers: [...factories.keys()],
    createSession: (policy, tools, provider) => {
      const factory = factories.get(provider), descriptor = descriptors.find(entry => entry.id === provider);
      if (!factory || !descriptor) throw new Error(`Unknown agent provider: ${provider}`);
      const session = factory.create(policy, tools, provider);
      return session;
    },
    hasStoredThreads: provider => factories.get(provider)?.stored() ?? false,
    directory: new FileThreadProviderDirectory(
      process.env.SHEPHERD_PROVIDER_STATE_DIR ?? join(homedir(), ".shepherd", "providers"),
      // Compatibility for conversations created before explicit bindings existed.
      (id) => id.startsWith("claude-") ? "claude" : "codex",
    ),
  };
}
