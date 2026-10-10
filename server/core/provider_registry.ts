import type { ProviderServices, ProviderSession } from "../ports/provider_v2.js";
import type { ProviderCapabilities, ProviderDescriptor, ProviderId, ThreadSettings, TurnInput } from "../../shared/protocol/v2/conversations.js";

export class ProviderCapabilityError extends Error {
  constructor(readonly capability: string) { super(`Unsupported provider capability: ${capability}.`); }
}
type SessionCapabilities = Pick<ProviderCapabilities, "fork" | "steering" | "compact" | "revert">;
type DeclaredCapabilities = Omit<ProviderCapabilities, "skills" | "resets">;
export interface ProviderRegistration {
  id: ProviderId;
  displayName: string;
  capabilities: DeclaredCapabilities;
  defaults: ProviderDescriptor["defaults"];
  services: ProviderServices;
}

/** Composition supplies native adapters; this registry has no provider identities. */
export class ProviderRegistry {
  private readonly registrations = new Map<ProviderId, { descriptor: ProviderDescriptor; services: ProviderServices }>();
  constructor(registrations: readonly ProviderRegistration[]) {
    for (const entry of registrations) {
      if (!/^[a-z][a-z0-9_-]{0,63}$/.test(entry.id)) throw new Error("Invalid provider ID.");
      if (!entry.displayName.trim()) throw new Error("Provider display name is required.");
      if (this.registrations.has(entry.id)) throw new Error(`Duplicate provider: ${entry.id}.`);
      const capabilities: ProviderCapabilities = {
        ...structuredClone(entry.capabilities),
        skills: { list: !!entry.services.skills?.list, configure: !!entry.services.skills?.configure },
        resets: !!entry.services.account?.resets,
      };
      validateThreadSettings(capabilities, { cwd: "", model: null, effort: null, ...entry.defaults });
      this.registrations.set(entry.id, { descriptor: { id: entry.id, displayName: entry.displayName, capabilities,
        defaults: structuredClone(entry.defaults) }, services: entry.services });
    }
  }
  enumerate(): ProviderDescriptor[] { return [...this.registrations.values()].map(({ descriptor }) => structuredClone(descriptor)); }
  descriptor(id: ProviderId): ProviderDescriptor { return structuredClone(this.lookup(id).descriptor); }
  services(id: ProviderId): ProviderServices { return this.lookup(id).services; }
  async createSession(id: ProviderId): Promise<ProviderSession> {
    const { descriptor, services } = this.lookup(id);
    const session = services.createSession();
    const actual: SessionCapabilities = { fork: !!session.fork, steering: !!session.steering, compact: !!session.compaction, revert: !!session.revert };
    const mismatch = session.provider !== id || (Object.keys(actual) as Array<keyof SessionCapabilities>)
      .some((key) => actual[key] !== descriptor.capabilities[key]);
    if (mismatch) {
      await session.stop();
      throw new Error(`Provider ${id} session ports do not match its descriptor.`);
    }
    return session;
  }
  private lookup(id: ProviderId) {
    const entry = this.registrations.get(id);
    if (!entry) throw new Error(`Unknown provider: ${id}.`);
    return entry;
  }
}

export function validateThreadSettings(capabilities: ProviderCapabilities, settings: ThreadSettings): void {
  if (!capabilities.approvalModes.includes(settings.approvalMode)) throw new ProviderCapabilityError(settings.approvalMode);
  if (!capabilities.sandboxModes.includes(settings.sandboxMode)) throw new ProviderCapabilityError(settings.sandboxMode);
}
export function validateTurnInput(capabilities: ProviderCapabilities, turn: TurnInput): void {
  if (turn.approvalMode && !capabilities.approvalModes.includes(turn.approvalMode)) throw new ProviderCapabilityError(turn.approvalMode);
  for (const part of turn.input) {
    if (!capabilities.inputKinds.includes(part.type)) throw new ProviderCapabilityError(part.type);
    if (part.type === "asset" && !capabilities.inputMedia.includes(part.media)) throw new ProviderCapabilityError(part.media);
  }
}
