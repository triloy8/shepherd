import type { ProviderServices, ProviderAccount } from "../ports/provider_services.js";
import type { Provider, ThreadSession } from "../ports/provider_session.js";
import type { ProviderCapabilities } from "../../shared/protocol/provider_capabilities.js";
import { scopedProvider, scopedProviderTools, parseScopedThreadId, withMethods } from "./provider_thread_identity.js";
import { FileThreadProviderDirectory } from "../storage/thread_provider_directory.js";
import type { ThreadDefaults } from "../../shared/protocol/provider_support.js";
import { resolveProfile, withinPolicy } from "../../shared/protocol/execution_policy.js";

/** How each provider applies the host policy, from the same capability metadata used to
 * register providers and without constructing sessions. Each notice names one provider that
 * cannot apply the policy exactly. */
export function describeThreadDefaults(defaults: ThreadDefaults, providers: readonly Pick<ProviderRegistration, "displayName" | "capabilities">[]): string[] {
  const limit = defaults.policy;
  if (!limit) return [];
  const requested = `SHEPHERD_POLICY (writes=${limit.writes}, network=${limit.network}, review=${limit.review})`;
  return providers.flatMap(({ displayName, capabilities }) => {
    const profile = resolveProfile(capabilities.policyProfiles, limit);
    if (!profile) return [`${displayName} has no mode within ${requested}; Shepherd refuses to start or resume its conversations until the setting changes.`];
    const exact = withinPolicy(limit, profile.policy);
    return exact ? [] : [`${displayName} has no mode matching ${requested} exactly; its conversations use the stricter "${profile.label}".`];
  });
}

export interface ProviderRegistration {
  id: string;
  displayName: string;
  capabilities: ProviderCapabilities;
  provider: Provider;
  account?: ProviderAccount;
  /** Native IDs are translated by default; application IDs must already be globally unique. */
  threadIdentity?: "native" | "application";
  hasStoredThreads: ProviderServices["hasStoredThreads"];
  ownsStoredThread?: (id: string) => boolean;
  shutdown?: () => void;
}

/** Whether an implementation reports the registered capabilities, compared after defaults. */
function sameCapabilities(expected: ProviderCapabilities, actual: ProviderCapabilities): boolean {
  return (Object.keys(expected) as Array<keyof ProviderCapabilities>).every(key => {
    if (key === "modelCatalogScope" || key === "modelCatalogAuthoritative") return true;
    const left = expected[key], right = actual[key];
    return Array.isArray(left) && Array.isArray(right) ? JSON.stringify([...left].sort()) === JSON.stringify([...right].sort()) : left === right;
  }) && (expected.modelCatalogScope ?? "conversation") === (actual.modelCatalogScope ?? "conversation")
    && (expected.modelCatalogAuthoritative === true) === (actual.modelCatalogAuthoritative === true);
}

/** Every advertised operation has an implementation where core calls it. */
function implemented(capabilities: ProviderCapabilities, operations: Partial<Record<keyof ProviderCapabilities, unknown>>): boolean {
  return (Object.keys(operations) as Array<keyof ProviderCapabilities>).every(operation => !capabilities[operation] || typeof operations[operation] === "function");
}

/** Check a provider's history and discovery methods when it is registered. */
function checkProvider(id: string, capabilities: ProviderCapabilities, provider: Provider): void {
  const providerCatalog = (capabilities.modelCatalogScope ?? "conversation") === "provider";
  if (!sameCapabilities(capabilities, provider.capabilities) || !implemented(capabilities, {
    rename: provider.setThreadName, archive: provider.archiveThread, unarchive: provider.unarchiveThread,
    ...(providerCatalog ? { modelCatalog: provider.listModels } : {}),
  })) throw new Error(`Provider capability contract mismatch: ${id}`);
}

/** Check a session's thread operations when the provider opens it. */
function checkSession(id: string, capabilities: ProviderCapabilities, session: ThreadSession): ThreadSession {
  const conversationCatalog = (capabilities.modelCatalogScope ?? "conversation") === "conversation";
  if (!sameCapabilities(capabilities, session.capabilities) || !implemented(capabilities, {
    steer: session.steerTurn, interrupt: session.interruptTurn, workspaceChange: session.setCwd, fork: session.forkThread,
    compact: session.compactThread, revert: session.revertThread, skills: session.listSkills, skillConfig: session.writeSkillConfig,
    ...(conversationCatalog ? { modelCatalog: session.listModels } : {}),
  })) { session.stop(); throw new Error(`Provider capability contract mismatch: ${id}`); }
  return session;
}

/** Registration works for any adapter; persistent recovery is evidence-based and unambiguous. */
export function assembleProviderServices(registrations: readonly ProviderRegistration[], stateDirectory: string, defaultProvider: string): ProviderServices {
  const entries = new Map<string, { registration: ProviderRegistration; provider: Provider }>();
  for (const registration of registrations) {
    if (!registration.id.trim() || registration.id.trim() !== registration.id || entries.has(registration.id)) throw new Error("Invalid or duplicate provider registration.");
    if (registration.capabilities.accountReset !== (typeof registration.account?.reset === "function")) throw new Error(`Provider capability contract mismatch: ${registration.id}`);
    const capabilities = structuredClone(registration.capabilities);
    checkProvider(registration.id, capabilities, registration.provider);
    const scoped = registration.threadIdentity !== "application";
    const native = registration.provider;
    // Sessions are checked as the provider opens them; scoped identities translate at this boundary.
    const checked = withMethods(native, {
      openSession: tools => checkSession(registration.id, capabilities, native.openSession(scoped ? scopedProviderTools(registration.id, tools) : tools)),
    });
    entries.set(registration.id, { registration: { ...registration, capabilities }, provider: scoped ? scopedProvider(registration.id, checked) : checked });
  }
  if (!entries.has(defaultProvider)) throw new Error(`The default agent provider "${defaultProvider}" is not registered.`);
  return {
    descriptors: [...entries.values()].map(({ registration: { id, displayName, capabilities, account } }) => ({ id, displayName, isDefault: id === defaultProvider, capabilities: { ...structuredClone(capabilities), modelCatalogAuthoritative: capabilities.modelCatalogAuthoritative === true }, accountReporting: !!account })),
    accounts: new Map(registrations.flatMap(registration => registration.account ? [[registration.id, registration.account] as const] : [])),
    providers: [...entries.keys()],
    defaultProvider,
    provider: id => {
      const entry = entries.get(id);
      if (!entry) throw new Error(`Unknown agent provider: ${id}`);
      return entry.provider;
    },
    hasStoredThreads: (provider, request) => entries.get(provider)?.registration.hasStoredThreads(provider, request) ?? false,
    shutdown: () => { for (const registration of registrations) { registration.provider.stop?.(); registration.shutdown?.(); } },
    directory: new FileThreadProviderDirectory(stateDirectory, id => {
      const identity = parseScopedThreadId(id);
      const owners = registrations.filter(registration => registration.threadIdentity === "application"
        ? !identity && registration.ownsStoredThread?.(id)
        : identity?.provider === registration.id && registration.ownsStoredThread?.(identity.nativeId));
      if (owners.length > 1) throw new Error("Ambiguous thread ownership; multiple providers own this identity.");
      return owners[0]?.id;
    }),
  };
}
