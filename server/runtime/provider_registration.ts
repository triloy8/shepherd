import type { ProviderServices, ProviderAccount, ProviderSessionFactory } from "../ports/provider_services.js";
import type { ProviderCapabilities } from "../../shared/protocol/provider_capabilities.js";
import { scopedProviderSession, scopedProviderTools, parseScopedThreadId } from "./provider_thread_identity.js";
import { FileThreadProviderDirectory } from "../storage/thread_provider_directory.js";
import { unsupportedThreadDefaults, type ThreadDefaults } from "../../shared/protocol/provider_support.js";

/** Check the same capability metadata used to register providers, without constructing sessions. */
export function describeThreadDefaults(defaults: ThreadDefaults, providers: readonly Pick<ProviderRegistration, "displayName" | "capabilities">[]): string[] {
  const settings = { approvalPolicy: ["SHEPHERD_APPROVAL_MODE", defaults.approvalPolicy], sandbox: ["SHEPHERD_SANDBOX_MODE", defaults.sandbox] } as const;
  return providers.flatMap(({ displayName, capabilities }) => unsupportedThreadDefaults(defaults, capabilities).map(key => {
    const [name, value] = settings[key];
    return `${displayName} does not support ${name}=${value}; its conversations use the agent's own default for that setting.`;
  }));
}

export interface ProviderRegistration {
  id: string;
  displayName: string;
  capabilities: ProviderCapabilities;
  create: ProviderSessionFactory;
  account?: ProviderAccount;
  /** Native IDs are translated by default; application IDs must already be globally unique. */
  threadIdentity?: "native" | "application";
  hasStoredThreads: ProviderServices["hasStoredThreads"];
  ownsStoredThread?: (id: string) => boolean;
  shutdown?: () => void;
}

/** Registration works for any adapter; persistent recovery is evidence-based and unambiguous. */
export function assembleProviderServices(registrations: readonly ProviderRegistration[], stateDirectory: string, defaultProvider: string): ProviderServices {
  const factories = new Map<string, ProviderRegistration>();
  for (const registration of registrations) {
    if (!registration.id.trim() || registration.id.trim() !== registration.id || factories.has(registration.id)) throw new Error("Invalid or duplicate provider registration.");
    if (registration.capabilities.accountReset !== (typeof registration.account?.reset === "function")) throw new Error(`Provider capability contract mismatch: ${registration.id}`);
    factories.set(registration.id, { ...registration, capabilities: structuredClone(registration.capabilities) });
  }
  if (!factories.has(defaultProvider)) throw new Error(`The default agent provider "${defaultProvider}" is not registered.`);
  return {
    descriptors: [...factories.values()].map(({ id, displayName, capabilities }) => ({ id, displayName, isDefault: id === defaultProvider, capabilities: { ...structuredClone(capabilities), modelCatalogAuthoritative: capabilities.modelCatalogAuthoritative === true }, accountReporting: !!factories.get(id)?.account })),
    accounts: new Map(registrations.flatMap(registration => registration.account ? [[registration.id, registration.account] as const] : [])),
    providers: [...factories.keys()],
    defaultProvider,
    createSession: (policy, tools, provider) => {
      const registration = factories.get(provider);
      if (!registration) throw new Error(`Unknown agent provider: ${provider}`);
      const scoped = registration.threadIdentity !== "application";
      const session = registration.create(policy, scoped ? scopedProviderTools(provider, tools) : tools, provider);
      const expected = registration.capabilities;
      const actual = session.capabilities;
      const matches = (Object.keys(expected) as Array<keyof ProviderCapabilities>).every(key => {
        if (key === "modelCatalogScope" || key === "modelCatalogAuthoritative") return true;
        const left = expected[key], right = actual[key];
        return Array.isArray(left) && Array.isArray(right)
          ? JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
          : left === right;
      });
      const operations = {
        steer: session.steerTurn, interrupt: session.interruptTurn,
        rename: session.setThreadName, archive: session.archiveThread, unarchive: session.unarchiveThread,
        workspaceChange: session.setCwd, modelCatalog: session.listModels,
        fork: session.forkThread, compact: session.compactThread, revert: session.revertThread,
        skills: session.listSkills, skillConfig: session.writeSkillConfig,
      };
      const methodsPresent = (Object.keys(operations) as Array<keyof typeof operations>)
        .every(operation => !expected[operation] || typeof operations[operation] === "function");
      const catalogRulesMatch = (expected.modelCatalogScope ?? "conversation") === (actual.modelCatalogScope ?? "conversation")
        && (expected.modelCatalogAuthoritative === true) === (actual.modelCatalogAuthoritative === true);
      if (!matches || !methodsPresent || !catalogRulesMatch) { session.stop(); throw new Error(`Provider capability contract mismatch: ${provider}`); }
      return scoped ? scopedProviderSession(provider, session) : session;
    },
    hasStoredThreads: (provider, request) => factories.get(provider)?.hasStoredThreads(provider, request) ?? false,
    shutdown: () => { for (const registration of registrations) registration.shutdown?.(); },
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
