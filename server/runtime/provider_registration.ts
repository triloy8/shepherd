import type { ProviderServices, ProviderAccount, ProviderSessionFactory } from "../ports/provider_services.js";
import type { ProviderCapabilities } from "../../shared/protocol/provider_capabilities.js";
import { FileThreadProviderDirectory } from "../storage/thread_provider_directory.js";

export interface ProviderRegistration {
  id: string;
  displayName: string;
  capabilities: ProviderCapabilities;
  create: ProviderSessionFactory;
  account: ProviderAccount;
  hasStoredThreads: ProviderServices["hasStoredThreads"];
  ownsStoredThread?: (id: string) => boolean;
  shutdown?: () => void;
}

/** Registration works for any adapter; persistent recovery is evidence-based and unambiguous. */
export function assembleProviderServices(registrations: readonly ProviderRegistration[], stateDirectory: string): ProviderServices {
  const factories = new Map<string, ProviderRegistration>();
  for (const registration of registrations) {
    if (!registration.id.trim() || registration.id.trim() !== registration.id || factories.has(registration.id)) throw new Error("Invalid or duplicate provider registration.");
    factories.set(registration.id, { ...registration, capabilities: structuredClone(registration.capabilities) });
  }
  return {
    descriptors: [...factories.values()].map(({ id, displayName, capabilities, account }) => ({ id, displayName, capabilities: { ...structuredClone(capabilities), resets: !!account.reset } })),
    accounts: new Map(registrations.map(registration => [registration.id, registration.account])),
    providers: [...factories.keys()],
    createSession: (policy, tools, provider) => {
      const registration = factories.get(provider);
      if (!registration) throw new Error(`Unknown agent provider: ${provider}`);
      const session = registration.create(policy, tools, provider);
      const expected = registration.capabilities;
      const actual = session.capabilities;
      const matches = (["questions", "skills", "compact", "revert", "fork", "sandboxModes", "approvalModes", "inputKinds", "imageDetail", "ephemeralThreads"] satisfies Array<keyof ProviderCapabilities>).every(key => {
        const left = expected[key], right = actual[key];
        return Array.isArray(left) && Array.isArray(right)
          ? JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
          : left === right;
      });
      const methodsPresent = (!expected.fork || !!session.forkThread) && (!expected.compact || !!session.compactThread) && (!expected.revert || !!session.revertThread) && (!expected.skills || (!!session.listSkills && !!session.writeSkillConfig));
      if (!matches || !methodsPresent) { session.stop(); throw new Error(`Provider capability contract mismatch: ${provider}`); }
      return session;
    },
    hasStoredThreads: (provider, request) => factories.get(provider)?.hasStoredThreads(provider, request) ?? false,
    shutdown: () => { for (const registration of registrations) registration.shutdown?.(); },
    directory: new FileThreadProviderDirectory(stateDirectory, id => {
      const owners = registrations.filter(registration => registration.ownsStoredThread?.(id));
      if (owners.length > 1) throw new Error("Ambiguous thread ownership; multiple providers own this identity.");
      return owners[0]?.id;
    }),
  };
}
