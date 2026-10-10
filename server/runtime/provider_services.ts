import { DynamicToolRegistry } from "../core/dynamic_tool_registry.js";
import { codexAccount } from "../providers/codex/neutral_account.js";
import { claudeAccount } from "../providers/claude/neutral_account.js";
import { readProviderDefaults } from "./provider_defaults.js";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderServices } from "../core/agent_provider.js";
import { CodexSession } from "../providers/codex/session.js";
import { ClaudeSession } from "../providers/claude/session.js";
import { ClaudeAccountLimits } from "../providers/claude/account_limits.js";
import { ClaudeThreadStore } from "../storage/claude_thread_store.js";
import { FileThreadProviderDirectory } from "../storage/thread_provider_directory.js";

/** The only production assembly point for application and native provider layers. */
export function createProviderServices(): ProviderServices {
  const store = new ClaudeThreadStore();
  const claudeLimits = new ClaudeAccountLimits();
  const defaults = readProviderDefaults(process.env);
  const sharedDefaults = readProviderDefaults({ SHEPHERD_APPROVAL_MODE: process.env.SHEPHERD_APPROVAL_MODE, SHEPHERD_SANDBOX_MODE: process.env.SHEPHERD_SANDBOX_MODE });
  const factories = new Map<string, { displayName: string; create: ProviderServices["createSession"]; stored: () => boolean }>([
    ["codex", { displayName: "Codex", create: (policy, tools) => new CodexSession(policy, tools), stored: () => false }],
    ["claude", { displayName: "Claude", create: (policy, tools) => new ClaudeSession(policy, tools, store, undefined, claudeLimits), stored: () => store.hasThreads() }],
  ]);
  const descriptors = [...factories].map(([id, factory]) => {
    const preview = factory.create("on-request", new DynamicToolRegistry(), id);
    const source = preview.neutral;
    if (!source?.controls) { preview.stop(); throw new Error(`Provider ${id} has no neutral conversation controls.`); }
    const capabilities = structuredClone(source.capabilities);
    capabilities.fork = preview.capabilities.fork; capabilities.compact = preview.capabilities.compact; capabilities.revert = preview.capabilities.revert;
    capabilities.skills = { list: !!source.controls.skills?.list, configure: !!source.controls.skills?.configure };
    if (capabilities.steering !== !!source.controls.steer) { preview.stop(); throw new Error(`Provider ${id} steering port does not match its descriptor.`); }
    const settings = source.controls.settings(); preview.stop();
    // Preserve the old shared approval setting; restricted legacy sandboxes
    // apply only to their adapter. Canonical settings are shared.
    const configuredDefaults = id === "codex" ? defaults : { ...sharedDefaults, approvalMode: defaults.approvalMode };
    const selected = { approvalMode: configuredDefaults.approvalMode ?? settings.approvalMode, sandboxMode: configuredDefaults.sandboxMode ?? settings.sandboxMode };
    if (!capabilities.approvalModes.includes(selected.approvalMode) || !capabilities.sandboxModes.includes(selected.sandboxMode)) throw new Error(`Configured defaults are unsupported by ${id}.`);
    return { id, displayName: factory.displayName, capabilities, defaults: selected };
  });
  let codexControl: CodexSession | null = null;
  const codex = async () => { codexControl ??= new CodexSession("on-request"); await codexControl.initialize(); return codexControl; };
  const neutralAccounts: NonNullable<ProviderServices["neutralAccounts"]> = new Map([
    ["codex", { read: async () => codexAccount(await (await codex()).readAccountRateLimits()), reset: async (input: { idempotencyKey: string; creditId?: string }) => {
      const result = await (await codex()).consumeRateLimitReset(input);
      const outcomes = { reset: "reset", alreadyRedeemed: "already_redeemed", nothingToReset: "nothing_to_reset", noCredit: "no_credit" } as const;
      return { outcome: outcomes[result.outcome] };
    } }],
    ["claude", { read: async (refresh?: boolean) => claudeAccount(await claudeLimits.read({ refresh })) }],
  ]);
  for (const descriptor of descriptors) descriptor.capabilities.resets = !!neutralAccounts.get(descriptor.id)?.reset;
  return {
    descriptors, neutralAccounts,
    accountLimits: { claude: claudeLimits },
    shutdown: () => { codexControl?.stop(); codexControl = null; },
    providers: [...factories.keys()],
    createSession: (policy, tools, provider) => {
      const factory = factories.get(provider), descriptor = descriptors.find(entry => entry.id === provider);
      if (!factory || !descriptor) throw new Error(`Unknown agent provider: ${provider}`);
      const session = factory.create(policy, tools, provider);
      Object.assign(session.neutral!.capabilities, structuredClone(descriptor.capabilities));
      // Provider adapters own neutral-to-native settings translation.
      const initialize = session.initialize.bind(session);
      let configured: Promise<unknown> | undefined;
      session.initialize = async () => {
        configured ??= session.neutral!.controls!.configure(descriptor.defaults);
        await configured;
        await initialize();
      };
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
