import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderServices } from "../core/agent_provider.js";
import { CodexSession } from "../providers/codex/session.js";
import { ClaudeSession } from "../providers/claude/session.js";
import { ClaudeThreadStore } from "../storage/claude_thread_store.js";
import { FileThreadProviderDirectory } from "../storage/thread_provider_directory.js";

/** The only production assembly point for application and native provider layers. */
export function createProviderServices(): ProviderServices {
  const store = new ClaudeThreadStore();
  return {
    providers: ["codex", "claude"],
    createSession: (policy, tools, provider) => {
      if (provider === "claude") return new ClaudeSession(policy, tools, store);
      if (provider === "codex") return new CodexSession(policy, tools);
      throw new Error(`Unknown agent provider: ${provider}`);
    },
    hasStoredThreads: (provider) => provider === "claude" && store.list().length > 0,
    directory: new FileThreadProviderDirectory(
      process.env.SHEPHERD_PROVIDER_STATE_DIR ?? join(homedir(), ".shepherd", "providers"),
      // Compatibility for conversations created before explicit bindings existed.
      (id) => id.startsWith("claude-") ? "claude" : "codex",
    ),
  };
}
